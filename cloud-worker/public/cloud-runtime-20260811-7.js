const API = "/cloud/api";
const APP_BUILD_ID = "20260811-7";
const PWA_WORKER_URL = "/cloud/media-worker.js";
const APP_UPDATE_EXPECTED_BUILD_KEY = "tcloud-app-update-expected-build";
const REMEMBER_LOGIN_KEY = "tcloud-login-remember";
const SORT_PREFERENCES_KEY = "tcloud-folder-sort-preferences-v1";
const SORT_PREFERENCE_LIMIT = 1000;
const VAULT_CACHE_DB = "tcloud-device-vault";
const VAULT_CACHE_STORE = "crypto-keys";
const FOLDER_CACHE_PREFIX = "folder-session:";
const state = {
  session: null,
  loginId: "",
  folderId: null,
  kind: "",
  view: "all",
  sort: "name",
  sortDirection: "asc",
  sortUsesTypeDefaults: true,
  query: "",
  files: [],
  folders: [],
  breadcrumbs: [],
  folderSummary: null,
  canTrashCurrentFolderContents: false,
  history: [],
  requests: [],
  shares: [],
  conflictGroups: [],
  conflictFileGroups: new Map(),
  conflictFolders: new Map(),
  conflictTopFolders: [],
  conflictScanRunning: false,
  conflictScanCompleted: false,
  conflictScanScheduled: false,
  selected: null,
  selectedFolder: null,
  shareTarget: null,
  listMode: false,
  selectedFiles: new Map(),
  selectedFolders: new Map(),
  selectionHistoryActive: false,
  selectionClearBackPending: false,
  moveDestinations: new Map(),
  selecting: false,
  dragDepth: 0,
  uploading: false,
  uploadAbort: null,
  pendingSafetyUpload: null,
  downloadAbort: null,
  wakeLock: null,
  wakeLockRequest: null,
  downloadActive: false,
  offlineActive: false,
  offlineAbort: null,
  offlineStatus: "",
  offlineManagerEntries: [],
  unlockedTopFolderNames: new Map(),
  previewUrl: "",
  previewMediaToken: "",
  previewPlayer: null,
  previewFileId: null,
  previewGeneration: 0,
  previewOrientationGeneration: 0,
  previewVideoFullscreenActive: false,
  previewHistoryActive: false,
  previewTouchStart: null,
  folderUploadSelection: null,
  folderUploadOperationSequence: 0,
  activeFolderUploadOperationId: null,
  installPrompt: null,
  thumbnailAttempts: new Set(),
  thumbnailBackfillRunning: false,
  durationUpdates: new Set(),
  durationAttempts: new Map(),
  durationQueue: [],
  durationObserver: null,
  durationBackfillRunning: false,
  durationScanGeneration: 0,
  conflictScanGeneration: 0,
  handlingPopState: false,
  historyReady: false,
  folderNamesMigrated: false,
  crypto: { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false }
};

const floatingToolbarState = {
  frame: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const PASSWORD_VISIBILITY_ICONS = `
  <svg class="password-eye password-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>
  <svg class="password-eye password-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><path d="M4 4l16 16"></path></svg>`;

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  TCloudOffline?.cleanupExpired?.().catch(() => {});
  window.setInterval(() => TCloudOffline?.cleanupExpired?.().catch(() => {}), 15 * 60 * 1000);
  await restoreInstalledAppPortrait();
  registerPwaWorker();
  updateInstallButtons();
  await restoreRememberedLogin();
  try {
    const session = await api("/session");
    if (session.authenticated) {
      const rememberedId = $("#login-id").value.trim().toLowerCase();
      const rememberedPassword = $("#login-password").value;
      let accountKey = null;
      if (session.role === "admin" && rememberedPassword && rememberedId === String(session.loginId || "").trim().toLowerCase()) {
        accountKey = (await TRoomCrypto.deriveAccountCredentials(rememberedPassword, rememberedId)).accountKey;
      }
      await enterApp(session, rememberedPassword, accountKey);
      $("#login-password").value = "";
    }
  } catch (error) {
    showLoginError(error.message);
  }
  reportCompletedAppUpdate();
}

function bindEvents() {
  bindPasswordVisibilityToggles();
  window.addEventListener("beforeinstallprompt", handleInstallPrompt);
  window.addEventListener("appinstalled", handleAppInstalled);
  $("#login-form").addEventListener("submit", login);
  $("#remember-login").addEventListener("change", syncLoginAutocomplete);
  $("#logout-button").addEventListener("click", logout);
  $("#vault-logout-button").addEventListener("click", logout);
  $("#install-app-button-top").addEventListener("click", installApp);
  $("#update-app-button-top").addEventListener("click", updateInstalledApp);
  $("#mobile-account-button").addEventListener("click", openAccountDialog);
  $("#usage-details-button").addEventListener("click", openUsageDetails);
  $("#mobile-usage-details-button").addEventListener("click", openUsageDetails);
  $("#upload-button").addEventListener("click", openAddAction);
  $("#mobile-add-button").addEventListener("click", openAddAction);
  $("#file-input").addEventListener("change", (event) => uploadFiles([...event.target.files]));
  $("#folder-input").addEventListener("change", handleFolderInput);
  document.addEventListener("dragenter", handleFileDragEnter);
  document.addEventListener("dragover", handleFileDragOver);
  document.addEventListener("dragleave", handleFileDragLeave);
  document.addEventListener("drop", handleFileDrop);
  window.addEventListener("blur", resetDropOverlay);
  $("#new-folder-button").addEventListener("click", openFolderDialog);
  $("#download-folder-button").addEventListener("click", downloadCurrentFolder);
  $("#mobile-upload-action").addEventListener("click", () => {
    $("#add-dialog").close();
    $("#file-input").click();
  });
  $("#mobile-folder-action").addEventListener("click", () => {
    $("#add-dialog").close();
    openFolderDialog();
  });
  $("#desktop-folder-upload-action").addEventListener("click", () => {
    $("#add-dialog").close();
    $("#folder-input").click();
  });
  $("#folder-form").addEventListener("submit", createFolder);
  $("#folder-password-enabled").addEventListener("change", toggleNewFolderPasswordInput);
  $("#folder-upload-more").addEventListener("click", () => $("#folder-input").click());
  $("#folder-upload-form").addEventListener("submit", uploadSelectedFolder);
  $("#unlock-form").addEventListener("submit", unlockFolder);
  $("#folder-settings-form").addEventListener("submit", saveFolderSettings);
  $("#folder-password-action").addEventListener("change", toggleFolderPasswordInput);
  $("#delete-folder-button").addEventListener("click", deleteSelectedFolder);
  $("#edit-form").addEventListener("submit", saveFile);
  $("#edit-file-button").addEventListener("click", openEditDialog);
  $("#delete-file-button").addEventListener("click", deleteSelectedFile);
  $("#conflict-groups-back").addEventListener("click", renderConflictGroupList);
  $("#share-file-button").addEventListener("click", () => openShareDialog("file", state.selected));
  $("#share-folder-button").addEventListener("click", () => openShareDialog("folder", state.selectedFolder));
  $("#share-form").addEventListener("submit", createShare);
  $("#generate-share-password").addEventListener("click", generateSharePassword);
  $("#copy-share-url").addEventListener("click", () => copyText($("#share-result-url").value, "共有URLをコピーしました。").catch((error) => setNotice(error.message, true)));
  $("#copy-share-password").addEventListener("click", () => copyText($("#share-result-password").value, "共有パスワードをコピーしました。").catch((error) => setNotice(error.message, true)));
  $("#copy-share-bundle").addEventListener("click", () => copyShareBundle().catch((error) => setNotice(error.message, true)));
  $("#close-share-result").addEventListener("click", () => $("#share-result-dialog").close());
  $("#share-dialog").addEventListener("close", clearShareFormSecrets);
  $("#share-result-dialog").addEventListener("close", clearShareResultSecrets);
  $("#restore-file-button").addEventListener("click", restoreSelectedFile);
  $("#permanent-delete-button").addEventListener("click", permanentlyDeleteSelectedFile);
  $("#empty-trash-button").addEventListener("click", emptyTrash);
  $("#download-link").addEventListener("click", (event) => {
    if (Number(state.selected?.cryptoVersion) !== 1) return;
    event.preventDefault();
    state.selectedFiles = new Map([[state.selected.id, state.selected]]);
    startSelectedDownloads();
  });
  $("#preview-dialog").addEventListener("close", handlePreviewClosed);
  $("#preview-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    $("#preview-dialog").close();
  });
  $("#preview-prev").addEventListener("click", () => navigatePreview(-1));
  $("#preview-next").addEventListener("click", () => navigatePreview(1));
  $("#preview-stage-wrap").addEventListener("dblclick", handlePreviewDoubleClick);
  $("#preview-stage-wrap").addEventListener("touchstart", handlePreviewTouchStart, { passive: true });
  $("#preview-stage-wrap").addEventListener("touchend", handlePreviewTouchEnd, { passive: true });
  document.addEventListener("fullscreenchange", handlePreviewFullscreenOrientationChange);
  document.addEventListener("webkitfullscreenchange", handlePreviewFullscreenOrientationChange);
  window.addEventListener("pageshow", enforceFolderPortraitOrientation);
  window.addEventListener("orientationchange", enforceFolderPortraitOrientation);
  document.addEventListener("visibilitychange", enforceFolderPortraitOrientation);
  document.addEventListener("keydown", handlePreviewKeydown);
  window.addEventListener("popstate", handleHistoryNavigation);
  const runSearch = debounce(async () => {
    await loadItems();
    scrollToResultsStart();
  }, 250);
  $$("#search-input, #floating-search-input").forEach((input) => input.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    syncSearchInputs(event.target);
    runSearch();
  }));
  $$(".sort-controls [data-sort-key]").forEach((button) => button.addEventListener("click", () => changeSort(button.dataset.sortKey)));
  $("#floating-search-input").addEventListener("focus", showFloatingToolbar);
  $("#floating-location-button").addEventListener("click", toggleFloatingLocation);
  document.addEventListener("click", closeFloatingLocationOnOutsideClick);
  window.addEventListener("scroll", queueFloatingToolbarUpdate, { passive: true });
  window.addEventListener("resize", queueFloatingToolbarUpdate, { passive: true });
  $("#display-toggle").addEventListener("click", () => { state.listMode = !state.listMode; renderItems(); });
  $("#selection-clear").addEventListener("click", clearSelectionWithoutRefresh);
  $("#selection-all").addEventListener("click", selectAllVisibleItems);
  $("#selection-rename").addEventListener("click", openSelectedRenameDialog);
  $("#selection-password").addEventListener("click", openSelectedFolderSettings);
  $("#selection-lock").addEventListener("click", lockSelectedTopFolder);
  $("#selection-download").addEventListener("click", startSelectedDownloads);
  $("#selection-offline").addEventListener("click", saveSelectedOffline);
  $("#selection-share").addEventListener("click", () => {
    const files = [...state.selectedFiles.values()];
    const folders = [...state.selectedFolders.values()];
    if (folders.length === 1 && !files.length) {
      openShareDialog("folder", folders[0]);
      return;
    }
    if (folders.length) return;
    if (files.length === 1) openShareDialog("file", files[0]);
    else if (files.length > 1) openShareDialog("selection", files);
  });
  $("#selection-move").addEventListener("click", openMoveDialog);
  $("#selection-delete").addEventListener("click", deleteSelectedItems);
  $("#clear-device-cache").addEventListener("click", clearCurrentDeviceCache);
  $("#open-offline-manager").addEventListener("click", openOfflineManager);
  $("#cancel-offline-save").addEventListener("click", cancelOfflineSave);
  $("#offline-cancel").addEventListener("click", cancelOfflineSave);
  $("#offline-dismiss").addEventListener("click", dismissOfflineProgress);
  $("#offline-select-all").addEventListener("click", selectAllOfflineEntries);
  $("#offline-delete-selected").addEventListener("click", deleteSelectedOfflineEntries);
  $("#offline-delete-all").addEventListener("click", deleteAllOfflineEntries);
  $("#offline-manager-list").addEventListener("change", syncOfflineManagerActions);
  $("#offline-manager-list").addEventListener("click", handleOfflineManagerClick);
  $("#move-form").addEventListener("submit", moveSelectedItems);
  $("#folder-rename-form").addEventListener("submit", saveFolderName);
  $("#upload-cancel").addEventListener("click", cancelUploads);
  $("#upload-dismiss").addEventListener("click", dismissUploadMessage);
  $("#upload-safety-cancel").addEventListener("click", cancelPendingSafetyUpload);
  $("#upload-safety-continue").addEventListener("click", continuePendingSafetyUpload);
  $("#download-cancel").addEventListener("click", cancelDownloads);
  $("#download-close").addEventListener("click", closeDownloadDialog);
  $("#download-retry-wake").addEventListener("click", requestTransferWakeLock);
  $("#keep-screen-awake").addEventListener("change", async (event) => {
    await syncTransferWakeLock();
  });
  document.addEventListener("visibilitychange", handleTransferVisibility);
  $("#vault-form").addEventListener("submit", handleVaultForm);
  $("#copy-recovery-code").addEventListener("click", copyRecoveryCode);
  $("#recovery-saved").addEventListener("change", (event) => { $("#recovery-close").disabled = !event.target.checked; });
  $("#recovery-close").addEventListener("click", closeRecoveryDialog);
  $$("[data-view], [data-kind]").forEach((button) => button.addEventListener("click", () => selectSection(button)));
  $$(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !["vault-dialog", "recovery-dialog"].includes(dialog.id)) dialog.close();
  }));
}

function handleInstallPrompt(event) {
  event.preventDefault();
  state.installPrompt = event;
  updateInstallButtons();
}

function handleAppInstalled() {
  state.installPrompt = null;
  updateInstallButtons();
  setNotice("T-Cloud Storageをホーム画面へ追加しました。");
}

function updateInstallButtons() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  $("#install-app-button-top").hidden = standalone;
  $("#update-app-button-top").hidden = !standalone;
}

function syncPasswordVisibilityToggle(button) {
  const input = document.getElementById(button?.dataset.passwordTarget || "");
  if (!button || !input) return;
  const visible = input.type === "text";
  const label = visible ? "パスワードを隠す" : "パスワードを表示";
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(visible));
  button.title = label;
}

function bindPasswordVisibilityToggles() {
  $$(".password-visibility-toggle[data-password-target]").forEach((button) => {
    button.innerHTML = PASSWORD_VISIBILITY_ICONS;
    syncPasswordVisibilityToggle(button);
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordTarget);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      syncPasswordVisibilityToggle(button);
    });
  });
}

async function updateInstalledApp() {
  const button = $("#update-app-button-top");
  if (!isInstalledAppMode()) return;
  if (state.uploading || state.activeFolderUploadOperationId || state.downloadActive || state.offlineActive) {
    setNotice("アップロード・ダウンロード完了後にアプリを更新してください。", true);
    return;
  }
  if (!navigator.onLine) {
    setNotice("インターネットへ接続してからアプリを更新してください。", true);
    return;
  }
  button.disabled = true;
  button.setAttribute("aria-label", "更新を確認中");
  button.title = "更新を確認中";
  setNotice("最新版を確認しています…");
  try {
    const versionResponse = await fetch(`${API}/app-version?app-update=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!versionResponse.ok) throw new Error("公開版の確認に失敗しました");
    const publishedBuild = String((await versionResponse.json()).buildId || "").trim();
    if (!publishedBuild) throw new Error("公開版の識別番号を確認できませんでした");

    const registration = await ensurePwaWorkerRegistration();
    const updateResult = await refreshPwaWorker(registration);
    if (!updateResult.activated) throw new Error("更新用プログラムの切り替えが完了しませんでした");

    if (publishedBuild === APP_BUILD_ID) {
      resetUpdateAppButton(button);
      setNotice(`最新版です（${APP_BUILD_ID}）`);
      return;
    }

    sessionStorage.setItem(APP_UPDATE_EXPECTED_BUILD_KEY, publishedBuild);
    setNotice(`新版（${publishedBuild}）へ切り替えています…`);
    const target = new URL(location.href);
    target.searchParams.set("app-update", publishedBuild);
    window.setTimeout(() => location.replace(target.href), 100);
  } catch (error) {
    resetUpdateAppButton(button);
    setNotice(`アプリを更新できませんでした：${error.message}`, true);
  }
}

function resetUpdateAppButton(button = $("#update-app-button-top")) {
  button.disabled = false;
  button.setAttribute("aria-label", "アプリを更新");
  button.title = "アプリを更新";
}

async function ensurePwaWorkerRegistration() {
  if (!("serviceWorker" in navigator)) throw new Error("この端末はアプリ更新に対応していません");
  return navigator.serviceWorker.register(PWA_WORKER_URL, { scope: "/cloud/", updateViaCache: "none" });
}

async function refreshPwaWorker(registration) {
  let detectedWorker = registration.installing || registration.waiting || null;
  const detectWorker = () => { detectedWorker = registration.installing || registration.waiting || detectedWorker; };
  registration.addEventListener("updatefound", detectWorker);
  try {
    await registration.update();
    const worker = registration.installing || registration.waiting || detectedWorker;
    if (!worker) return { changed: false, activated: true };
    if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
    const activated = await waitForPwaWorkerActivation(worker);
    return { changed: true, activated };
  } finally {
    registration.removeEventListener("updatefound", detectWorker);
  }
}

function waitForPwaWorkerActivation(worker, timeoutMs = 12000) {
  if (worker.state === "activated") return Promise.resolve(true);
  if (worker.state === "redundant") return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("statechange", onStateChange);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve(result);
    };
    const onStateChange = () => {
      if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      if (worker.state === "activated") finish(true);
      if (worker.state === "redundant") finish(false);
    };
    const onControllerChange = () => finish(true);
    const timer = setTimeout(() => finish(worker.state === "activated"), timeoutMs);
    worker.addEventListener("statechange", onStateChange);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    onStateChange();
  });
}

function reportCompletedAppUpdate() {
  const expectedBuild = sessionStorage.getItem(APP_UPDATE_EXPECTED_BUILD_KEY);
  if (!expectedBuild) return;
  sessionStorage.removeItem(APP_UPDATE_EXPECTED_BUILD_KEY);
  if (expectedBuild === APP_BUILD_ID) setNotice(`アプリを${APP_BUILD_ID}へ更新しました`);
  else setNotice(`アプリ更新を確認できませんでした（現在 ${APP_BUILD_ID}／公開 ${expectedBuild}）`, true);
}

async function installApp() {
  const prompt = state.installPrompt;
  if (prompt) {
    await prompt.prompt();
    await prompt.userChoice.catch(() => null);
    state.installPrompt = null;
    updateInstallButtons();
    return;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  $("#install-guide-copy").textContent = ios
    ? "Safariの共有ボタンを押し、「ホーム画面に追加」→「追加」の順に選んでください。"
    : android
      ? "ブラウザ右上のメニューを開き、「ホーム画面に追加」または「アプリをインストール」を選んでください。"
      : "ブラウザのメニューまたはアドレスバーにある「アプリをインストール」「ホーム画面に追加」を選んでください。";
  $("#install-guide-dialog").showModal();
}

async function registerPwaWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await ensurePwaWorkerRegistration();
    await registration.update();
  } catch (error) {
    console.warn("T-Cloud app worker registration failed", error);
  }
}

function syncLoginAutocomplete() {
  const remember = $("#remember-login").checked;
  $("#login-id").setAttribute("autocomplete", remember ? "username" : "off");
  $("#login-password").setAttribute("autocomplete", remember ? "current-password" : "off");
}

async function changeSort(key) {
  if (!["updated", "name", "size"].includes(key)) return;
  if (state.sort === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  else {
    state.sort = key;
    state.sortDirection = key === "name" ? "asc" : "desc";
  }
  state.sortUsesTypeDefaults = false;
  rememberCurrentSort();
  syncSortControls();
  await loadItems();
  scrollToResultsStart();
}

function resetTypeDefaultSort() {
  const fileView = Boolean(state.folderId || state.kind);
  state.sort = fileView ? "updated" : "name";
  state.sortDirection = fileView ? "desc" : "asc";
  state.sortUsesTypeDefaults = true;
  syncSortControls();
}

function restoreFolderSortPreference(folderId = state.folderId) {
  const preferences = readSortPreferences();
  const saved = preferences[sortPreferenceLocationKey(folderId)];
  if (!saved || !["updated", "name", "size"].includes(saved.sort) || !["asc", "desc"].includes(saved.direction)) {
    resetTypeDefaultSort();
    return;
  }
  state.sort = saved.sort;
  state.sortDirection = saved.direction;
  state.sortUsesTypeDefaults = false;
  syncSortControls();
}

function rememberCurrentSort(folderId = state.folderId) {
  const preferences = readSortPreferences();
  preferences[sortPreferenceLocationKey(folderId)] = {
    sort: state.sort,
    direction: state.sortDirection,
    savedAt: Date.now()
  };
  const entries = Object.entries(preferences).sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0));
  const limited = Object.fromEntries(entries.slice(0, SORT_PREFERENCE_LIMIT));
  try { localStorage.setItem(SORT_PREFERENCES_KEY, JSON.stringify(limited)); } catch {}
}

function readSortPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_PREFERENCES_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function sortPreferenceLocationKey(folderId = state.folderId) {
  const role = state.session?.role === "admin" ? "admin" : "subadmin";
  const location = folderId ? `folder:${Number(folderId)}` : "root";
  return `${role}:${location}`;
}

function syncSortControls() {
  $$(".sort-controls [data-sort-key]").forEach((button) => {
    const active = button.dataset.sortKey === state.sort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    const direction = active ? state.sortDirection : button.dataset.sortKey === "name" ? "asc" : "desc";
    button.querySelector("span").textContent = direction === "asc" ? "↑" : "↓";
  });
}

async function restoreRememberedLogin() {
  const remember = localStorage.getItem(REMEMBER_LOGIN_KEY) === "1";
  $("#remember-login").checked = remember;
  syncLoginAutocomplete();
  if (!remember || !navigator.credentials?.get || !globalThis.PasswordCredential) return;
  try {
    const credential = await navigator.credentials.get({ password: true, mediation: "optional" });
    if (credential?.type !== "password") return;
    $("#login-id").value = credential.id || "";
    $("#login-password").value = credential.password || "";
  } catch {
    // ブラウザ側で認証情報の取得が拒否された場合は、空欄のまま手入力に戻す。
  }
}

async function updateRememberedLogin(loginId, password) {
  if (!$("#remember-login").checked) {
    localStorage.removeItem(REMEMBER_LOGIN_KEY);
    return;
  }
  localStorage.setItem(REMEMBER_LOGIN_KEY, "1");
  if (!navigator.credentials?.store || !globalThis.PasswordCredential) return;
  try {
    await navigator.credentials.store(new PasswordCredential({
      id: loginId,
      password,
      name: "T-Cloud Storage"
    }));
  } catch {
    // 保存の許可や管理はブラウザ側に委ね、ログイン自体は失敗させない。
  }
}

function openAddAction() {
  $("#add-dialog").showModal();
}

function isFileDrag(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  return [...(transfer.types || [])].includes("Files")
    || [...(transfer.items || [])].some((item) => item.kind === "file")
    || Boolean(transfer.files?.length);
}

function canAcceptDroppedFiles() {
  return Boolean(state.session?.canUpload)
    && state.crypto.fileEncryptionReady
    && !state.uploading
    && !["trash", "history", "requests", "shares"].includes(state.view);
}

function handleFileDragEnter(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (!canAcceptDroppedFiles()) return;
  state.dragDepth += 1;
  $("#drop-overlay").hidden = false;
}

function handleFileDragOver(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = canAcceptDroppedFiles() ? "copy" : "none";
}

function handleFileDragLeave(event) {
  if (!state.dragDepth) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (!state.dragDepth) resetDropOverlay();
}

function resetDropOverlay() {
  state.dragDepth = 0;
  $("#drop-overlay").hidden = true;
}

async function handleFileDrop(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  resetDropOverlay();
  if (!canAcceptDroppedFiles()) {
    const message = state.uploading
      ? "アップロードが完了してから、次のファイルを追加してください。"
      : "保存先のフォルダを開いてから、ファイルをドロップしてください。";
    setNotice(message, true);
    return;
  }
  try {
    const dropped = await collectDroppedContent(event.dataTransfer);
    if (dropped.folderSelection) {
      if (dropped.looseFiles.length && !state.folderId) {
        setNotice("フォルダとファイルをまとめて追加する場合は、ファイルの保存先フォルダを開いてからドロップしてください。", true);
        return;
      }
      dropped.folderSelection.looseFiles = dropped.looseFiles;
      openFolderUploadDialog(dropped.folderSelection, { append: $("#folder-upload-dialog").open });
      return;
    }
    if (!dropped.looseFiles.length) {
      setNotice("ドロップしたファイルまたはフォルダを読み取れませんでした。もう一度ドロップしてください。", true);
      return;
    }
    if (!state.folderId) {
      setNotice("ファイルを追加する場合は、保存先のフォルダを開いてからドロップしてください。", true);
      return;
    }
    uploadFiles(dropped.looseFiles);
  } catch (error) {
    setNotice(`ドロップしたデータの読み取りに失敗しました：${error.message}`, true);
  }
}

function handleFolderInput(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (!files.length) return;
  try {
    const selection = normalizeFolderSelection(files.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
    openFolderUploadDialog(selection, { append: $("#folder-upload-dialog").open });
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function collectDroppedContent(dataTransfer) {
  const records = [];
  const directories = new Set();
  const candidates = [...(dataTransfer?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => {
      let handlePromise = null;
      let entry = null;
      if (typeof item.getAsFileSystemHandle === "function") {
        try { handlePromise = Promise.resolve(item.getAsFileSystemHandle()); } catch {}
      }
      if (typeof item.webkitGetAsEntry === "function") {
        try { entry = item.webkitGetAsEntry(); } catch {}
      }
      return { handlePromise, entry };
    });
  for (const candidate of candidates) {
    let handle = null;
    if (candidate.handlePromise) try { handle = await candidate.handlePromise; } catch {}
    if (handle) {
      await collectDroppedHandle(handle, "", records, directories);
      continue;
    }
    const entry = candidate.entry;
    if (!entry) continue;
    await collectDroppedEntry(entry, "", records, directories);
  }
  for (const file of [...(dataTransfer?.files || [])]) {
    const relativePath = normalizeRelativePath(file.webkitRelativePath || file.name);
    if (relativePath) records.push({ file, relativePath });
  }
  const uniqueRecords = new Map();
  for (const record of records) {
    const relativePath = normalizeRelativePath(record.relativePath || record.file?.name);
    if (!record.file || !relativePath) continue;
    const identity = [relativePath, Number(record.file.size || 0), Number(record.file.lastModified || 0)].join("\u0000");
    if (!uniqueRecords.has(identity)) uniqueRecords.set(identity, { file: record.file, relativePath });
  }
  const folderRecords = [];
  const looseFiles = [];
  for (const record of uniqueRecords.values()) {
    if (record.relativePath.includes("/")) folderRecords.push(record);
    else looseFiles.push(record.file);
  }
  const folderSelection = directories.size || folderRecords.length
    ? normalizeFolderSelection(folderRecords, directories)
    : null;
  return { folderSelection, looseFiles };
}

async function collectDroppedHandle(handle, parentPath, records, directories) {
  const relativePath = [parentPath, handle.name].filter(Boolean).join("/");
  if (handle.kind === "file") {
    records.push({ file: await handle.getFile(), relativePath });
    return;
  }
  if (handle.kind !== "directory") return;
  directories.add(relativePath);
  if (typeof handle.values !== "function") throw new Error(`${relativePath} の中身を読み取れませんでした。`);
  for await (const child of handle.values()) await collectDroppedHandle(child, relativePath, records, directories);
}

async function collectDroppedEntry(entry, parentPath, records, directories) {
  const relativePath = [parentPath, entry.name].filter(Boolean).join("/");
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    records.push({ file, relativePath });
    return;
  }
  if (!entry.isDirectory) return;
  directories.add(relativePath);
  const reader = entry.createReader();
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await collectDroppedEntry(child, relativePath, records, directories);
  }
}

function normalizeFolderSelection(records, explicitDirectories = new Set()) {
  const directories = new Set([...explicitDirectories].map(normalizeRelativePath).filter(Boolean));
  const files = [];
  for (const record of records) {
    const relativePath = normalizeRelativePath(record.relativePath || record.file?.name);
    if (!record.file || !relativePath) continue;
    const parts = relativePath.split("/");
    if (parts.length < 2) continue;
    files.push({ file: record.file, relativePath });
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join("/"));
  }
  const roots = [...directories].filter((path) => !path.includes("/")).sort((a, b) => a.localeCompare(b, "ja"));
  if (!roots.length) throw new Error("アップロードするフォルダを確認してください。");
  return { files, directories: [...directories].sort(compareFolderPaths), roots };
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}

function compareFolderPaths(left, right) {
  const depth = left.split("/").length - right.split("/").length;
  return depth || left.localeCompare(right, "ja");
}

function mergeFolderSelections(current, incoming) {
  if (!current) return incoming;
  const directories = new Set([...current.directories, ...incoming.directories]);
  const files = new Map();
  for (const record of [...current.files, ...incoming.files]) {
    const file = record.file;
    const identity = [record.relativePath, Number(file?.size || 0), Number(file?.lastModified || 0)].join("\u0000");
    if (!files.has(identity)) files.set(identity, record);
  }
  const merged = normalizeFolderSelection([...files.values()], directories);
  const looseFiles = new Map();
  for (const file of [...(current.looseFiles || []), ...(incoming.looseFiles || [])]) {
    const identity = [file.name, Number(file.size || 0), Number(file.lastModified || 0)].join("\u0000");
    if (!looseFiles.has(identity)) looseFiles.set(identity, file);
  }
  merged.looseFiles = [...looseFiles.values()];
  return merged;
}

function openFolderUploadDialog(selection, { append = false } = {}) {
  if (!selection?.roots?.length) return;
  if (state.uploading || state.activeFolderUploadOperationId) {
    setNotice("現在のアップロードが完了してから、次のフォルダを追加してください。", true);
    return;
  }
  const dialog = $("#folder-upload-dialog");
  state.folderUploadSelection = append ? mergeFolderSelections(state.folderUploadSelection, selection) : selection;
  const queued = state.folderUploadSelection;
  const fileCount = queued.files.length + (queued.looseFiles?.length || 0);
  $("#folder-upload-summary").textContent = `${queued.roots.length.toLocaleString("ja-JP")}フォルダ・${fileCount.toLocaleString("ja-JP")}ファイルを、フォルダ構成を保ってまとめて保存します。（${queued.roots.join("、")}）`;
  const topLevelUpload = !state.folderId;
  $("#folder-upload-password-row").hidden = !topLevelUpload;
  $("#folder-upload-password-note").hidden = !topLevelUpload;
  $("#folder-upload-password").required = topLevelUpload;
  if (!topLevelUpload) $("#folder-upload-password").value = "";
  $("#folder-upload-error").textContent = "";
  if (!dialog.open) dialog.showModal();
}

function openFolderDialog() {
  const topLevelFolder = !state.folderId;
  $("#folder-password-enabled").checked = topLevelFolder;
  $("#folder-password-enabled").disabled = topLevelFolder;
  $("#folder-password").value = "";
  toggleNewFolderPasswordInput();
  $("#folder-dialog").showModal();
}

function toggleNewFolderPasswordInput() {
  const topLevelFolder = !state.folderId;
  if (topLevelFolder) $("#folder-password-enabled").checked = true;
  const enabled = topLevelFolder || $("#folder-password-enabled").checked;
  $("#folder-password-row").hidden = !enabled;
  $("#folder-password-note").hidden = !enabled;
  $("#folder-password").required = enabled;
  if (!enabled) $("#folder-password").value = "";
}

async function login(event) {
  event.preventDefault();
  showLoginError("");
  const submit = event.submitter || $("#login-form button[type='submit']");
  submit.disabled = true;
  try {
    const loginId = $("#login-id").value.trim().toLowerCase();
    const password = $("#login-password").value;
    const mode = await api("/auth-mode");
    const credentials = await TRoomCrypto.deriveAccountCredentials(password, loginId);
    const loginBody = mode.mode === "proof"
      ? { loginId, authProof: credentials.authProof }
      : { loginId, password };
    const session = await api("/login", {
      method: "POST",
      body: JSON.stringify(loginBody)
    });
    await updateRememberedLogin(loginId, password);
    await enterApp(session, password, credentials.accountKey);
    $("#login-password").value = "";
  } catch (error) {
    showLoginError(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function enterApp(session, password = "", accountKey = null) {
  state.session = session;
  state.loginId = String(session.loginId || $("#login-id").value || "").trim().toLowerCase();
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#account-name").textContent = session.accountName;
  syncAccountIdentity();
  $("#edit-file-button").hidden = !session.canEditFiles && !session.canRenameUnlockedItems;
  $("#delete-file-button").hidden = !session.canDelete && !session.canTrashUnlockedFiles;
  $$('[data-view="trash"]').forEach((button) => { button.hidden = !session.canDelete; });
  $$('[data-view="conflicts"]').forEach((button) => { button.hidden = false; });
  $$('[data-view="shares"]').forEach((button) => { button.hidden = session.role !== "admin"; });
  $("#share-file-button").hidden = session.role !== "admin";
  $("#share-folder-button").hidden = session.role !== "admin";
  syncAvailableActions();
  $("#storage-meter").hidden = session.role !== "admin";
  $("#mobile-storage-summary").hidden = session.role !== "admin";
  $("#mobile-usage-details-action").hidden = session.role !== "admin";
  if (session.role === "admin") loadUsage();
  const restoredNavigation = initializeNavigationHistory();
  await prepareCryptoSession(password, accountKey);
  const loaded = await loadItems();
  if (!loaded.ok && restoredNavigation.folderId && [403, 404, 423].includes(Number(loaded.error?.status))) {
    await navigateToFolder(null, "フォルダ", { pushHistory: false, load: false });
    history.replaceState(navigationEntry(null, "フォルダ"), "", location.href);
    await loadItems();
    setNotice("前回開いていたフォルダの再確認が必要なため、フォルダ一覧を表示しました。", true);
  }
  scheduleLegacyFolderMigration();
}

async function logout() {
  state.crypto = { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false };
  await clearCachedAdminKeys();
  await api("/logout", { method: "POST", body: "{}" });
  location.reload();
}

function initializeNavigationHistory() {
  if (state.historyReady) return navigationEntry(state.folderId, $("#view-title").textContent);
  const saved = history.state?.tcloud ? history.state : null;
  const folderId = Number.isInteger(Number(saved?.folderId)) && Number(saved.folderId) > 0 ? Number(saved.folderId) : null;
  const folderName = String(saved?.folderName || (folderId ? "ファイル" : "フォルダ"));
  state.folderId = folderId;
  state.kind = "";
  state.view = "all";
  restoreFolderSortPreference(folderId);
  $("#view-title").textContent = folderName;
  history.replaceState(navigationEntry(folderId, folderName), "", location.href);
  state.historyReady = true;
  return navigationEntry(folderId, folderName);
}

function navigationEntry(folderId, folderName) {
  return { tcloud: true, folderId: folderId ? Number(folderId) : null, folderName: folderName || (folderId ? "ファイル" : "フォルダ"), previewId: null };
}

async function navigateToFolder(folderId, folderName, options = {}) {
  enforceFolderPortraitOrientation();
  const { pushHistory = true, load = true } = options;
  const replaceSelectionHistory = pushHistory && state.selectionHistoryActive;
  if (replaceSelectionHistory) {
    clearFileSelection(true, false);
    state.selectionHistoryActive = false;
  }
  state.folderId = folderId ? Number(folderId) : null;
  state.kind = "";
  state.view = "all";
  restoreFolderSortPreference(state.folderId);
  clearSearch();
  $("#view-title").textContent = folderName || (state.folderId ? "ファイル" : "フォルダ");
  if (pushHistory && state.historyReady) {
    const entry = navigationEntry(state.folderId, $("#view-title").textContent);
    if (replaceSelectionHistory) history.replaceState(entry, "", location.href);
    else history.pushState(entry, "", location.href);
  }
  syncNavigationActiveState();
  syncAvailableActions();
  if (load) await loadItems();
}

async function handleHistoryNavigation(event) {
  const target = event.state;
  if (!target?.tcloud) return;
  state.handlingPopState = true;
  try {
    const sameFolder = Number(target.folderId || 0) === Number(state.folderId || 0);
    if (state.selectionClearBackPending) {
      state.selectionClearBackPending = false;
      if (sameFolder && !target.previewId) return;
    }
    const previewOriginId = $("#preview-dialog").open && sameFolder && !target.previewId
      ? Number(state.previewFileId)
      : null;
    if (state.selectedFiles.size || state.selectedFolders.size) {
      state.selectionHistoryActive = false;
      clearFileSelection(true, false);
      if (sameFolder && !target.previewId) return;
    }
    state.previewHistoryActive = false;
    if ($("#preview-dialog").open) $("#preview-dialog").close();
    if (previewOriginId) {
      restorePreviewOrigin(previewOriginId);
      return;
    }
    await navigateToFolder(target.folderId, target.folderName, { pushHistory: false });
    if (target.previewId) {
      const file = state.files.find((item) => Number(item.id) === Number(target.previewId));
      if (file) await openPreview(file, { pushHistory: false });
    }
  } finally {
    state.handlingPopState = false;
  }
}

function restorePreviewOrigin(fileId) {
  requestAnimationFrame(() => {
    const card = $(`.file-card[data-file-id="${Number(fileId)}"]`);
    card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

async function prepareCryptoSession(password = "", accountKey = null) {
  try {
    const config = await api("/crypto-config");
    state.crypto.config = config;
    if (!config.initialized) {
      setCryptoStatus("暗号化鍵：初期設定前", false);
      if (state.session.role === "admin") openVaultDialog("setup");
      else setNotice("管理者による暗号化の初期設定が必要です。", true);
      return;
    }
    state.crypto.publicKey = await crypto.subtle.importKey(
      "jwk",
      config.publicKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
    state.crypto.fileEncryptionReady = true;
    syncAvailableActions();
    if (state.session.role !== "admin") {
      if (accountKey) state.crypto.accountKey = accountKey;
      else if (password) state.crypto.accountKey = await TRoomCrypto.deriveAccountKey(password, state.loginId);
      await loadCachedFolderKeys();
      setCryptoStatus("暗号化鍵：フォルダ単位", true);
      return;
    }
    if (!password) {
      const cachedPrivateKey = await loadCachedAdminKey(config);
      if (cachedPrivateKey) {
        state.crypto.adminPrivateKey = cachedPrivateKey;
        setCryptoStatus("暗号化鍵：解除済み", true);
        return;
      }
      setCryptoStatus("暗号化鍵：ロック中", false);
      openVaultDialog("unlock");
      return;
    }
    const resolvedAccountKey = accountKey || await TRoomCrypto.deriveAccountKey(password, state.loginId);
    const privateKey = await TRoomCrypto.unlockAdminPrivateKey(resolvedAccountKey, config);
    state.crypto.accountKey = resolvedAccountKey;
    state.crypto.adminPrivateKey = privateKey;
    await saveCachedAdminKey(config, privateKey);
    setCryptoStatus("暗号化鍵：解除済み", true);
  } catch (error) {
    setCryptoStatus("暗号化鍵：要確認", false);
    setNotice(error.message, true);
    if (state.session?.role === "admin") openVaultDialog(state.crypto.config?.initialized ? "unlock" : "setup");
  }
}

function openVaultDialog(mode) {
  const isSetup = mode === "setup";
  $("#vault-dialog").dataset.mode = mode;
  $("#vault-title").textContent = isSetup ? "暗号化を初期設定" : "暗号化鍵を解除";
  const localNotice = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? " 現在はローカル確認環境です。ここで作る復旧鍵は本番環境へ引き継がれないため、画面確認だけにしてください。"
    : "";
  $("#vault-copy").textContent = isSetup
    ? `管理者用の暗号化鍵と緊急用復旧鍵をこの端末で生成します。処理には数秒かかることがあります。${localNotice}`
    : "ファイルを復号するため、管理者パスワードをもう一度入力してください。パスワードは暗号化鍵の生成にだけ使用します。";
  $("#vault-submit").textContent = isSetup ? "暗号化を設定する" : "暗号化鍵を解除";
  $("#vault-password").value = "";
  $("#vault-error").textContent = "";
  if (!$("#vault-dialog").open) $("#vault-dialog").showModal();
  setTimeout(() => $("#vault-password").focus(), 80);
}

async function handleVaultForm(event) {
  event.preventDefault();
  const mode = $("#vault-dialog").dataset.mode || "unlock";
  const submit = $("#vault-submit");
  submit.disabled = true;
  $("#vault-password").disabled = true;
  $("#vault-error").textContent = "";
  submit.textContent = mode === "setup" ? "安全な鍵を生成中…" : "暗号化鍵を確認中…";
  try {
    const accountKey = await TRoomCrypto.deriveAccountKey($("#vault-password").value, state.loginId);
    if (mode === "setup") {
      const vault = await TRoomCrypto.createVault(accountKey);
      await api("/crypto-setup", { method: "POST", body: JSON.stringify(vault.payload) });
      state.crypto.config = await api("/crypto-config");
      state.crypto.accountKey = accountKey;
      state.crypto.adminPrivateKey = vault.privateKey;
      state.crypto.publicKey = await crypto.subtle.importKey("jwk", vault.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      state.crypto.fileEncryptionReady = true;
      await saveCachedAdminKey(state.crypto.config, vault.privateKey);
      syncAvailableActions();
      $("#vault-dialog").close();
      showRecoveryCode(vault.recoveryCode);
      setCryptoStatus("暗号化鍵：解除済み", true);
      setNotice("端末側暗号化の初期設定が完了しました。復旧鍵を安全に保管してください。");
      await loadItems();
      scheduleLegacyFolderMigration();
    } else {
      const privateKey = await TRoomCrypto.unlockAdminPrivateKey(accountKey, state.crypto.config);
      state.crypto.accountKey = accountKey;
      state.crypto.adminPrivateKey = privateKey;
      await saveCachedAdminKey(state.crypto.config, privateKey);
      $("#vault-dialog").close();
      setCryptoStatus("暗号化鍵：解除済み", true);
      setNotice("暗号化鍵を解除しました。");
      await loadItems();
      scheduleLegacyFolderMigration();
    }
  } catch (error) {
    $("#vault-error").textContent = error.message;
  } finally {
    $("#vault-password").value = "";
    $("#vault-password").disabled = false;
    submit.disabled = false;
    submit.textContent = mode === "setup" ? "暗号化を設定する" : "暗号化鍵を解除";
  }
}

function vaultCacheKey(config) {
  return `${state.loginId}:${String(config?.createdAt || "v1")}`;
}

function openVaultCache() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VAULT_CACHE_STORE)) request.result.createObjectStore(VAULT_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("端末内の暗号化鍵保存領域を開けませんでした。"));
  });
}

async function loadCachedAdminKey(config) {
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return null;
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readonly").objectStore(VAULT_CACHE_STORE).get(vaultCacheKey(config));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    const key = record?.privateKey;
    return key instanceof CryptoKey && key.type === "private" && key.extractable === false ? key : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function saveCachedAdminKey(config, privateKey) {
  if (!(privateKey instanceof CryptoKey) || privateKey.type !== "private" || privateKey.extractable) return;
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readwrite").objectStore(VAULT_CACHE_STORE)
        .put({ privateKey, storedAt: Date.now() }, vaultCacheKey(config));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // 保存できないブラウザでは、従来どおり再入力で解除する。
  } finally {
    database?.close();
  }
}

async function clearCachedAdminKeys() {
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readwrite").objectStore(VAULT_CACHE_STORE).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // ログアウト処理は、端末保存領域の削除失敗だけでは止めない。
  } finally {
    database?.close();
  }
}

function folderCacheKey(folderId) {
  return `${FOLDER_CACHE_PREFIX}${String(state.session?.sessionCacheId || "")}:${Number(folderId)}`;
}

async function loadCachedFolderKeys() {
  if (state.session?.role !== "subadmin" || !state.session?.sessionCacheId) return;
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readonly").objectStore(VAULT_CACHE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const currentSession = String(state.session.sessionCacheId);
    for (const record of records) {
      if (record?.cacheType !== "folder" || String(record.sessionCacheId) !== currentSession) continue;
      if (record.folderKey instanceof CryptoKey && record.folderKey.type === "secret") {
        state.crypto.folderKeys.set(Number(record.folderId), record.folderKey);
      }
    }
    await removeStaleFolderKeyCache(currentSession);
  } catch {
    // 端末保存が使えない場合も、通常のフォルダPW解除は利用できる。
  } finally {
    database?.close();
  }
}

async function saveCachedFolderKey(folderId, folderKey) {
  if (state.session?.role !== "subadmin" || !state.session?.sessionCacheId || !(folderKey instanceof CryptoKey) || folderKey.type !== "secret") return;
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readwrite").objectStore(VAULT_CACHE_STORE).put({
        cacheType: "folder",
        sessionCacheId: String(state.session.sessionCacheId),
        folderId: Number(folderId),
        folderKey,
        storedAt: Date.now()
      }, folderCacheKey(folderId));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // 保存できないブラウザでは、再読み込み後にフォルダPWを再入力する。
  } finally {
    database?.close();
  }
}

async function removeStaleFolderKeyCache(currentSession) {
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction(VAULT_CACHE_STORE, "readonly").objectStore(VAULT_CACHE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const stale = records.filter((record) => record?.cacheType === "folder" && String(record.sessionCacheId) !== String(currentSession));
    if (!stale.length) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(VAULT_CACHE_STORE, "readwrite");
      const store = transaction.objectStore(VAULT_CACHE_STORE);
      for (const record of stale) store.delete(`${FOLDER_CACHE_PREFIX}${String(record.sessionCacheId)}:${Number(record.folderId)}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database?.close();
  }
}

function isLegacyFolderName(name) {
  return !String(name || "").trim() || name === "[encrypted]";
}

async function migrateLegacyFolderNames() {
  if (state.folderNamesMigrated || state.session?.role !== "admin" || !state.crypto.adminPrivateKey) return;
  try {
    const data = await api("/legacy-folders");
    let changed = false;
    for (const folder of data.folders || []) {
      const key = await ensureAdminFolderKey(folder);
      const plaintextName = await TRoomCrypto.decryptFolderName(folder, key);
      await api(`/folders/${folder.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          cryptoVersion: 1,
          name: plaintextName,
          encryptedName: folder.encryptedName,
          nameIv: folder.nameIv,
          passwordAction: "keep"
        })
      });
      changed = true;
    }
    state.folderNamesMigrated = true;
    return changed;
  } catch (error) {
    console.warn("Folder name migration was deferred.", error);
    return false;
  }
}

function scheduleLegacyFolderMigration() {
  if (state.folderNamesMigrated || state.session?.role !== "admin" || !state.crypto.adminPrivateKey) return;
  const run = () => migrateLegacyFolderNames().then((changed) => {
    if (changed && state.view === "all") loadItems();
  });
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else window.setTimeout(run, 250);
}

function showRecoveryCode(code) {
  $("#recovery-code").value = code;
  $("#recovery-saved").checked = false;
  $("#recovery-close").disabled = true;
  $("#copy-recovery-code").textContent = "復旧鍵をコピー";
  $("#recovery-dialog").showModal();
}

async function copyRecoveryCode() {
  try {
    await navigator.clipboard.writeText($("#recovery-code").value);
    $("#copy-recovery-code").textContent = "コピーしました";
  } catch {
    $("#recovery-code").select();
    $("#copy-recovery-code").textContent = "選択しました。端末のコピー操作を使用してください";
  }
}

function closeRecoveryDialog() {
  if (!$("#recovery-saved").checked) return;
  $("#recovery-code").value = "";
  $("#recovery-dialog").close();
}

function setCryptoStatus(text, ready) {
  const node = $("#crypto-status");
  node.textContent = text;
  node.classList.toggle("ready", Boolean(ready));
}

function selectSection(button) {
  clearFileSelection();
  if (button.dataset.kind && !state.folderId) {
    setNotice("写真や動画は、PWを解除してフォルダを開いてから絞り込めます。", true);
    return;
  }
  if (button.dataset.view === "all") {
    navigateToFolder(null, "フォルダ");
    return;
  } else if (["trash", "history", "conflicts", "requests", "shares"].includes(button.dataset.view)) {
    state.folderId = null;
    state.kind = "";
    clearSearch();
  } else {
    state.kind = button.dataset.kind || "";
    restoreFolderSortPreference(state.folderId);
  }
  state.view = button.dataset.view || "all";
  const labels = { all: state.folderId ? "ファイル" : "フォルダ", trash: "ゴミ箱", history: "操作履歴", conflicts: "競合", requests: "削除申請", shares: "共有管理", image: "写真", video: "動画", audio: "音声", document: "書類" };
  $("#view-title").textContent = labels[state.view] || labels[state.kind] || "ファイル";
  syncNavigationActiveState();
  syncAvailableActions();
  loadItems();
}

function syncNavigationActiveState() {
  $$("[data-view], [data-kind]").forEach((item) => {
    const active = item.dataset.kind
      ? state.view === "all" && state.kind === item.dataset.kind
      : state.view === item.dataset.view && !state.kind;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });
}

function clearSearch() {
  state.query = "";
  syncSearchInputs();
}

async function removeCachedFolderKeys(folderIds) {
  const ids = [...new Set((folderIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  for (const id of ids) state.crypto.folderKeys.delete(id);
  if (state.session?.role !== "subadmin" || !state.session?.sessionCacheId || !ids.length) return;
  let database = null;
  try {
    database = await openVaultCache();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(VAULT_CACHE_STORE, "readwrite");
      const store = transaction.objectStore(VAULT_CACHE_STORE);
      for (const id of ids) store.delete(folderCacheKey(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // メモリ上の鍵は破棄済み。端末キャッシュ削除失敗は次回のサーバー認証で遮断する。
  } finally {
    database?.close();
  }
}

function syncSearchInputs(source = null) {
  $$("#search-input, #floating-search-input").forEach((input) => {
    if (input !== source && input.value !== state.query) input.value = state.query;
  });
}

function syncAvailableActions() {
  const inTrash = state.view === "trash";
  const inHistory = state.view === "history";
  const inConflicts = state.view === "conflicts";
  const inRequests = state.view === "requests";
  const inShares = state.view === "shares";
  const insideFolder = Boolean(state.folderId);
  $("#new-folder-button").hidden = inTrash || inHistory || inConflicts || inRequests || inShares;
  $("#new-folder-button").disabled = !state.crypto.publicKey;
  $("#upload-button").hidden = inTrash || inHistory || inConflicts || inRequests || inShares || !state.session?.canUpload;
  $("#upload-button").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#desktop-folder-upload-action").hidden = !state.session?.canUpload;
  $("#desktop-folder-upload-action").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#download-folder-button").hidden = !insideFolder || inTrash || inHistory || inConflicts || inRequests || inShares || !("showDirectoryPicker" in window);
  $("#download-folder-button").disabled = state.downloadActive;
  $("#mobile-add-button").hidden = inTrash || inHistory || inConflicts || inRequests || inShares;
  $("#mobile-upload-action").hidden = !insideFolder || !state.session?.canUpload;
  $("#mobile-upload-action").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#toolbar").hidden = inHistory || inConflicts || inRequests || inShares;
  $$("#search-input, #floating-search-input").forEach((input) => {
    input.placeholder = insideFolder ? "ファイル名を検索" : "フォルダ名を検索";
  });
  if (inHistory || inConflicts || inRequests || inShares || state.uploading || state.downloadActive) hideFloatingToolbar();
  $$('[data-kind]').forEach((button) => { button.disabled = !insideFolder || inTrash || inHistory || inConflicts || inRequests || inShares; });
}

async function loadItems() {
  invalidateStoredConflicts();
  clearFileSelection(false);
  setNotice("");
  state.folderSummary = null;
  state.canTrashCurrentFolderContents = false;
  try {
    if (state.view === "trash") {
      const data = await api("/trash");
      state.folders = (await hydrateFolderRecords(data.folders || [])).map((folder) => ({ ...folder, trashed: true }));
      state.files = (await hydrateFileRecords(data.files || [])).map((file) => ({ ...file, trashed: true }));
      state.history = [];
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs([]);
    } else if (state.view === "conflicts") {
      state.folders = [];
      state.files = [];
      state.history = [];
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs([]);
      state.conflictScanRunning = true;
      renderItems();
      await loadConflictOverview();
    } else if (state.view === "history") {
      const data = await api("/upload-history");
      state.folders = [];
      state.files = [];
      state.history = await hydrateUploadHistoryRecords(data.history || []);
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs([]);
    } else if (state.view === "requests") {
      const data = await api("/deletion-requests");
      state.folders = [];
      state.files = [];
      state.history = [];
      state.requests = await hydrateDeletionRequestRecords(data.requests || []);
      state.shares = [];
      renderBreadcrumbs([]);
    } else if (state.view === "shares") {
      if (state.session?.role !== "admin") throw new Error("共有管理は管理者だけ利用できます。");
      const data = await api("/shares");
      state.folders = [];
      state.files = [];
      state.history = [];
      state.requests = [];
      state.shares = await hydrateShareRecords(data.shares || []);
      renderBreadcrumbs([]);
    } else {
      const params = new URLSearchParams({ sort: `${state.sort}-${state.sortDirection}` });
      if (state.folderId) params.set("folderId", state.folderId);
      if (state.kind) params.set("kind", state.kind);
      if (state.query) params.set("q", state.query);
      const data = await api(`/items?${params}`);
      state.canTrashCurrentFolderContents = Boolean(data.canTrashContents);
      state.folderSummary = state.folderId ? {
        fileCount: Number(data.folder?.fileCount || 0),
        folderCount: Number(data.folder?.folderCount || 0),
        totalFileCount: Number(data.folder?.totalFileCount || 0),
        totalSizeBytes: Number(data.folder?.totalSizeBytes || 0)
      } : null;
      state.folders = await hydrateFolderRecords(data.folders || []);
      state.files = await hydrateFileRecords(data.files || []);
      state.history = [];
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs(await hydrateFolderRecords(data.breadcrumbs || [], { preserveOrder: true }));
    }
    renderItems();
    syncUnlockedTopFolderNames();
    scheduleStoredConflictScan();
    return { ok: true, error: null };
  } catch (error) {
    handleError(error);
    return { ok: false, error };
  }
}

function renderItems() {
  renderFolderSummary();
  const grid = $("#content-grid");
  grid.classList.toggle("list-mode", state.listMode || state.view === "history" || state.view === "conflicts" || state.view === "requests" || state.view === "shares");
  grid.classList.toggle("conflict-overview", state.view === "conflicts");
  grid.innerHTML = "";
  if (state.view === "conflicts") renderConflictOverview(grid);
  if (state.view === "history") {
    for (const item of state.history) grid.append(historyCard(item));
  }
  if (state.view === "requests") {
    for (const item of state.requests) grid.append(deletionRequestCard(item));
  }
  if (state.view === "shares") {
    for (const item of state.shares) grid.append(shareCard(item));
  }
  for (const folder of state.folders) grid.append(folder.trashed ? trashFolderCard(folder) : folderCard(folder));
  for (const file of state.files) grid.append(fileCard(file));
  const conflictItemCount = state.conflictGroups.length + (state.conflictScanRunning ? 1 : 0);
  $("#empty-state").hidden = state.folders.length + state.files.length + state.history.length + state.requests.length + state.shares.length + conflictItemCount > 0;
  $("#empty-title").textContent = state.view === "requests" ? "削除申請はありません" : state.view === "conflicts" ? "競合候補はありません" : state.view === "history" ? "履歴がありません" : state.view === "shares" ? "共有URLはありません" : state.view === "trash" ? "ゴミ箱は空です" : (state.folderId ? "ファイルがありません" : "フォルダがありません");
  $("#empty-copy").textContent = state.view === "requests"
    ? "副管理者から申請が届くと、ここに表示されます。"
    : state.view === "conflicts"
    ? (state.session?.role === "subadmin" ? "PWを解除したトップフォルダ内に、競合候補はありません。" : "トップフォルダごとに確認しましたが、競合候補はありません。")
    : state.view === "history"
    ? "ファイルのアップロードが完了すると、ここに記録されます。"
    : state.view === "shares"
    ? "ファイルまたはフォルダから、期限付きの共有URLを発行できます。"
    : state.view === "trash"
    ? "削除されたファイルはありません。"
    : state.folderId
      ? "このフォルダには、まだファイルがありません。"
      : "フォルダを作成すると、ここに表示されます。";
  $("#display-toggle").textContent = state.listMode ? "▦" : "▤";
  $("#display-toggle").setAttribute("aria-label", state.listMode ? "1:1表示へ切り替え" : "横長表示へ切り替え");
  $("#display-toggle").title = state.listMode ? "1:1表示へ切り替え" : "横長表示へ切り替え";
  $("#empty-trash-button").hidden = state.view !== "trash" || !state.session?.canDelete || state.files.length + state.folders.length === 0;
  scheduleMissingMediaDurations();
  scheduleMissingVideoThumbnails();
  queueFloatingToolbarUpdate();
}

function queueFloatingToolbarUpdate() {
  if (floatingToolbarState.frame) return;
  floatingToolbarState.frame = requestAnimationFrame(() => {
    floatingToolbarState.frame = 0;
    updateFloatingToolbarFromScroll();
  });
}

function updateFloatingToolbarFromScroll() {
  const scrollY = Math.max(0, window.scrollY);
  if (floatingToolbarAvailable(scrollY)) showFloatingToolbar();
  else hideFloatingToolbar();
}

function floatingToolbarAvailable(scrollY = Math.max(0, window.scrollY)) {
  const toolbar = $("#toolbar");
  if (!state.session || $("#app-view").hidden || toolbar.hidden) return false;
  if (!$("#selection-bar").hidden || state.uploading || state.downloadActive) return false;
  if (document.querySelector("dialog[open]")) return false;
  return scrollY > floatingToolbarTrigger();
}

function floatingToolbarTrigger() {
  const toolbar = $("#toolbar");
  return toolbar.offsetTop + toolbar.offsetHeight + 12;
}

function showFloatingToolbar() {
  if (!floatingToolbarAvailable()) return;
  const toolbar = $("#floating-toolbar");
  toolbar.classList.add("is-visible");
  toolbar.setAttribute("aria-hidden", "false");
}

function hideFloatingToolbar() {
  const toolbar = $("#floating-toolbar");
  toolbar.classList.remove("is-visible");
  toolbar.setAttribute("aria-hidden", "true");
  closeFloatingLocation();
}

function scrollToResultsStart() {
  const grid = $("#content-grid");
  if (!grid || !floatingToolbarAvailable()) return;
  const floatingHeight = $("#floating-toolbar").offsetHeight;
  const resultsTarget = grid.getBoundingClientRect().top + window.scrollY - floatingHeight - 16;
  const target = Math.max(floatingToolbarTrigger() + 1, resultsTarget);
  window.scrollTo({ top: target, behavior: "smooth" });
  showFloatingToolbar();
}

function toggleFloatingLocation() {
  const panel = $("#floating-location-panel");
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  $("#floating-location-button").setAttribute("aria-expanded", String(willOpen));
}

function closeFloatingLocation() {
  $("#floating-location-panel").hidden = true;
  $("#floating-location-button").setAttribute("aria-expanded", "false");
}

function closeFloatingLocationOnOutsideClick(event) {
  if (!event.target.closest(".floating-toolbar-location")) closeFloatingLocation();
}

function renderFloatingLocation(items) {
  state.breadcrumbs = items;
  const currentName = items.at(-1)?.name || (state.folderId ? $("#view-title").textContent : "すべてのファイル");
  const pathNames = ["Cloud Storage", ...items.map((item) => item.name)];
  $("#floating-folder-name").textContent = currentName;
  $("#floating-location-button").title = pathNames.join(" / ");
  const nav = $("#floating-breadcrumbs");
  nav.innerHTML = "";
  const appendLocation = (name, folderId = null) => {
    if (nav.childElementCount) {
      const divider = document.createElement("span");
      divider.textContent = "/";
      divider.setAttribute("aria-hidden", "true");
      nav.append(divider);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      closeFloatingLocation();
      navigateToFolder(folderId, folderId ? name : "フォルダ");
    });
    nav.append(button);
  };
  appendLocation("Cloud Storage");
  for (const item of items) appendLocation(item.name, item.id);
}

function renderFolderSummary() {
  const summary = $("#view-summary");
  const visible = state.view === "all" && Boolean(state.folderId) && Boolean(state.folderSummary);
  summary.hidden = !visible;
  if (!visible) {
    summary.textContent = "";
    return;
  }
  const showUnlockedTotals = state.session?.role === "subadmin" && state.crypto.folderKeys.has(Number(state.folderId));
  summary.textContent = showUnlockedTotals
    ? `総ファイル数：${state.folderSummary.totalFileCount.toLocaleString("ja-JP")}ファイル・総容量：${formatBytes(state.folderSummary.totalSizeBytes)}`
    : formatFolderCount(state.folderSummary);
}

function formatFolderCount(folder) {
  return `${Number(folder.fileCount || 0)}ファイル・${Number(folder.folderCount || 0)}フォルダ`;
}

function canRenameFolder(folder) {
  if (state.session?.canEditFolders) return true;
  return Boolean(state.session?.canRenameUnlockedItems && folder?.isUnlocked && state.crypto.folderKeys.has(Number(folder.id)));
}

function syncAccountIdentity() {
  const subadmin = state.session?.role === "subadmin";
  const permissionText = state.session?.role === "admin" ? "すべての操作が可能" : "";
  const unlockedNames = [...state.unlockedTopFolderNames.values()];
  const accountText = subadmin ? (unlockedNames.length ? unlockedNames.join("\n") : "未ログイン") : (state.session?.accountName || "—");
  $("#account-name").textContent = accountText;
  $("#mobile-account-name").textContent = accountText;
  $("#account-permission").textContent = permissionText;
  $("#mobile-account-permission").textContent = permissionText;
  $("#account-permission").hidden = subadmin;
  $("#mobile-account-permission").hidden = subadmin;
}

function syncUnlockedTopFolderNames() {
  if (state.session?.role !== "subadmin") {
    syncAccountIdentity();
    return;
  }
  if (state.view === "all" && !state.folderId) {
    const next = new Map();
    for (const folder of state.folders) {
      const id = Number(folder.id);
      if (state.crypto.folderKeys.has(id) && folder.isUnlocked) next.set(id, folder.name);
    }
    state.unlockedTopFolderNames = next;
  } else if (state.view === "all" && state.breadcrumbs.length) {
    const root = state.breadcrumbs[0];
    const id = Number(root.id);
    if (state.crypto.folderKeys.has(id)) state.unlockedTopFolderNames.set(id, root.name);
  }
  syncAccountIdentity();
}

function canOpenFolderSettings(folder) {
  return Boolean(state.session?.role === "admin" || canChangeFolderPassword(folder) || canTrashFolder(folder));
}

function canChangeFolderPassword(folder) {
  if (state.session?.canEditFolders) return true;
  return Boolean(state.session?.canRenameUnlockedItems
    && folder?.isProtected
    && folder?.isUnlocked
    && state.crypto.folderKeys.has(Number(folder.id)));
}

function canRelockTopFolder(folder) {
  return Boolean(state.session?.role === "subadmin"
    && folder
    && !folder.parentId
    && folder.isProtected
    && folder.isUnlocked
    && state.crypto.folderKeys.has(Number(folder.id)));
}

function canRenameFile(file) {
  if (state.session?.canEditFiles) return true;
  return Boolean(state.session?.canRenameUnlockedItems && !file?.trashed && file?.fileKey && state.crypto.folderKeys.has(Number(file.folderId)));
}

function canTrashFile(file) {
  if (state.session?.canDelete) return true;
  return Boolean(state.session?.canTrashUnlockedFiles
    && state.canTrashCurrentFolderContents
    && !file?.trashed
    && Number(file?.folderId) === Number(state.folderId));
}

function canTrashFolder(folder) {
  if (state.session?.canDelete) return true;
  return Boolean(state.session?.canTrashUnlockedFiles
    && state.canTrashCurrentFolderContents
    && folder?.parentId
    && Number(folder.parentId) === Number(state.folderId)
    && (!folder.isProtected || folder.isUnlocked));
}

function unlockedMoveScopeRoot() {
  return state.breadcrumbs.find((folder) => folder.isProtected && state.crypto.folderKeys.has(Number(folder.id))) || null;
}

function canMoveFile(file) {
  if (state.session?.canEditFiles) return !file?.trashed;
  return Boolean(state.session?.canRenameUnlockedItems
    && state.canTrashCurrentFolderContents
    && unlockedMoveScopeRoot()
    && !file?.trashed
    && file?.fileKey
    && Number(file.folderId) === Number(state.folderId));
}

function canMoveFolder(folder) {
  if (state.session?.canEditFolders) return !folder?.trashed;
  return Boolean(state.session?.canRenameUnlockedItems
    && state.canTrashCurrentFolderContents
    && unlockedMoveScopeRoot()
    && !folder?.trashed
    && Number(folder.parentId) === Number(state.folderId)
    && state.crypto.folderKeys.has(Number(folder.id)));
}

function trashFolderCard(folder) {
  const card = document.createElement("article");
  card.className = "folder-card trash-folder-card";
  const button = document.createElement("button");
  button.className = "folder-open-button";
  button.type = "button";
  button.innerHTML = `<span class="folder-icon">▰</span><span><strong>${escapeHtml(folder.name)}</strong><small class="folder-count">${formatFolderCount(folder)}・${formatBytes(folder.sizeBytes)}</small><small class="folder-lock">フォルダごとゴミ箱へ移動済み</small></span>`;
  button.addEventListener("click", () => showTrashFolderActions(folder));
  card.append(button);
  return card;
}

function folderCard(folder) {
  const card = document.createElement("article");
  card.className = "folder-card";
  card.dataset.folderId = String(folder.id);
  const button = document.createElement("button");
  button.className = "folder-open-button";
  button.type = "button";
  const inheritsProtection = Boolean(folder.parentId && !folder.isProtected);
  const lock = folder.adminAccess ? " · 管理者アクセス" : inheritsProtection ? " · ロック解除済み" : folder.isProtected ? (folder.isUnlocked ? " · 解除済み" : " · ロック") : "";
  button.innerHTML = `<span class="folder-icon">${folder.isProtected || inheritsProtection ? "▣" : "▰"}</span><span><strong>${escapeHtml(folder.name)}</strong><small class="folder-count">${formatFolderCount(folder)}</small>${lock ? `<small class="folder-lock">${escapeHtml(lock.slice(3))}</small>` : ""}</span>`;
  button.addEventListener("click", () => {
    if (card.dataset.longPressed === "true") {
      card.dataset.longPressed = "false";
      return;
    }
    if (state.selectedFiles.size || state.selectedFolders.size) {
      toggleFolderSelection(folder, card);
      return;
    }
    openFolder(folder);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    selectFolder(folder, card);
  });
  installFolderLongPressSelection(card, folder);
  card.append(button);
  const selectButton = document.createElement("button");
  selectButton.className = "folder-select-button";
  selectButton.type = "button";
  selectButton.setAttribute("aria-label", `${folder.name}を選択`);
  selectButton.setAttribute("aria-pressed", state.selectedFolders.has(folder.id) ? "true" : "false");
  selectButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  selectButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFolderSelection(folder, card);
  });
  card.append(selectButton);
  if (state.selectedFolders.has(folder.id)) card.classList.add("selected", "selection-pass");
  return card;
}

async function hydrateFolderRecords(records, options = {}) {
  const hydrated = [];
  for (const original of records) {
    const folder = { ...original };
    if (Number(folder.cryptoVersion) === 1) {
      let key = state.crypto.folderKeys.get(folder.id);
      if (!key && folder.parentId && folder.parentWrappedKey) {
        const parentKey = state.crypto.folderKeys.get(Number(folder.parentId));
        if (parentKey) {
          try {
            key = await TRoomCrypto.unlockFolderFromParent(folder, parentKey);
            state.crypto.folderKeys.set(Number(folder.id), key);
            await saveCachedFolderKey(folder.id, key);
          } catch {}
        }
      }
      if (!key && state.session?.role === "admin" && state.crypto.adminPrivateKey) {
        try { key = await ensureAdminFolderKey(folder); } catch {}
      }
      if (key && isLegacyFolderName(folder.name)) {
        try { folder.name = await TRoomCrypto.decryptFolderName(folder, key); }
        catch { folder.name = "名称を移行できないフォルダ"; }
      }
      folder.isUnlocked = Boolean(key);
    }
    hydrated.push(folder);
  }
  let result = hydrated;
  if (options.preserveOrder) return result;
  if (state.query) result = result.filter((folder) => folder.name.toLocaleLowerCase("ja").includes(state.query.toLocaleLowerCase("ja")));
  const direction = state.sortDirection === "asc" ? 1 : -1;
  if (state.sortUsesTypeDefaults) result.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
  else if (state.sort === "name") result.sort((a, b) => direction * a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
  else if (state.sort === "updated") result.sort((a, b) => direction * String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
  else result.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
  return result;
}

async function ensureAdminFolderKey(folder) {
  let key = state.crypto.folderKeys.get(folder.id);
  if (key) return key;
  if (!state.crypto.adminPrivateKey) throw new Error("管理者の暗号化鍵を解除してください。");
  key = await TRoomCrypto.unlockFolderAsAdmin(folder, state.crypto.adminPrivateKey);
  state.crypto.folderKeys.set(folder.id, key);
  return key;
}

function findFolderRecord(id) {
  return state.folders.find((folder) => Number(folder.id) === Number(id));
}

function historyCard(item) {
  const card = document.createElement("article");
  card.className = "history-card";
  const failed = item.eventType === "download_failed";
  card.innerHTML = `<span class="history-kind">${kindSymbol(item.mediaKind)}</span><span class="history-main"><strong>${escapeHtml(item.name)}</strong><small>${item.actorLabel} · ${escapeHtml(item.eventLabel || "操作完了")}${item.deleted ? " · 削除済み" : ""}</small></span><span class="history-meta"><strong${failed ? ' class="history-error"' : ""}>${failed ? "エラー" : formatBytes(item.sizeBytes)}</strong><small>${formatDate(item.uploadedAt)}</small></span>`;
  return card;
}

async function hydrateShareRecords(records) {
  const hydrated = [];
  for (const original of records) {
    const share = { ...original, targetName: "利用できない対象", shareUrl: "", targetKey: null };
    try {
      if (share.targetType === "folder" && share.folder) {
        const [folder] = await hydrateFolderRecords([share.folder]);
        share.folder = folder;
        share.targetName = folder.name;
        share.targetKey = state.crypto.folderKeys.get(Number(folder.id)) || await ensureAdminFolderKey(folder);
      } else if (["file", "selection"].includes(share.targetType) && share.file) {
        const [file] = await hydrateFileRecords([share.file]);
        share.file = file;
        share.targetName = share.targetType === "selection" ? `${Number(share.fileCount || 0)}件のファイル` : file.name;
        share.targetKey = file.fileKey || null;
      }
      if (share.targetKey) {
        const token = await TRoomCrypto.decryptShareToken(share, share.targetKey);
        share.shareUrl = `${location.origin}/cloud/share/${token}`;
      }
    } catch {
      share.targetName = "復号できない共有対象";
    }
    hydrated.push(share);
  }
  return hydrated;
}

function shareCard(share) {
  const card = document.createElement("article");
  card.className = "share-card";
  const status = ({ active: "有効", expired: "期限終了", stopped: "停止済み", unavailable: "対象なし" })[share.status] || "確認中";
  const type = share.targetType === "folder" ? "フォルダ" : share.targetType === "selection" ? "選択したファイル" : "ファイル";
  card.innerHTML = `
    <span class="share-kind">${share.targetType === "folder" ? "▰" : share.targetType === "selection" ? "▦" : kindSymbol(share.file?.mediaKind)}</span>
    <span class="share-main"><strong>${escapeHtml(share.targetName)}</strong><small>${type} · ${formatDateTime(share.createdAt)}に発行</small></span>
    <span class="share-meta"><strong class="share-status ${share.status}">${status}</strong><small>期限 ${formatEpoch(share.expiresAt)}</small><small>DL ${share.downloadCount}件 / エラー ${share.errorCount}件</small></span>`;
  const actions = document.createElement("div");
  actions.className = "share-card-actions";
  const copy = actionButton("URLをコピー", "secondary-button", () => copyText(share.shareUrl, "共有URLをコピーしました。").catch((error) => setNotice(error.message, true)));
  copy.disabled = !share.shareUrl;
  const history = actionButton("履歴", "secondary-button", () => openShareEvents(share));
  actions.append(copy, history);
  if (share.status === "active") actions.append(actionButton("共有を停止", "danger-button", () => stopShare(share)));
  card.append(actions);
  return card;
}

function actionButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function openShareDialog(type, target) {
  if (state.session?.role !== "admin" || !target) return;
  try {
    let targetKey = null;
    if (type === "folder") targetKey = state.crypto.folderKeys.get(Number(target.id)) || await ensureAdminFolderKey(target);
    else if (type === "selection") targetKey = target[0]?.fileKey;
    else targetKey = target.fileKey;
    if (!targetKey) throw new Error("共有対象の暗号化鍵を解除できません。");
    const files = type === "selection" ? target : null;
    const id = type === "selection" ? Number(files[0].id) : Number(target.id);
    const name = type === "selection" ? `${files.length}件のファイル` : target.name;
    state.shareTarget = { type, id, name, targetKey, files };
    $("#share-target").textContent = `共有対象：${name}（${type === "folder" ? "フォルダ" : type === "selection" ? "選択したファイル" : "ファイル"}）`;
    $("#share-expires").value = localDateTimeValue(Date.now() + 7 * 24 * 60 * 60 * 1000);
    $("#share-password").value = "";
    $("#share-password").type = "password";
    syncPasswordVisibilityToggle($("#toggle-share-password"));
    $("#generated-share-password").hidden = true;
    $("#generated-share-password").textContent = "";
    $("#share-error").textContent = "";
    $("#preview-dialog").open && $("#preview-dialog").close();
    $("#folder-settings-dialog").open && $("#folder-settings-dialog").close();
    $("#share-dialog").showModal();
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function generateSharePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%+-_";
  const random = crypto.getRandomValues(new Uint8Array(28));
  const password = [...random].map((value) => alphabet[value % alphabet.length]).join("");
  random.fill(0);
  $("#share-password").value = password;
  $("#generated-share-password").textContent = password;
  $("#generated-share-password").hidden = false;
  try { await copyText(password, "強固な共有パスワードを生成し、コピーしました。"); }
  catch { setNotice("共有パスワードを生成しました。端末のコピー権限がないため、表示された文字列をコピーしてください。", true); }
}

async function createShare(event) {
  event.preventDefault();
  const target = state.shareTarget;
  if (!target || state.session?.role !== "admin") return;
  const submit = event.submitter || $("#share-form button[type='submit']");
  submit.disabled = true;
  $("#share-error").textContent = "";
  try {
    const expiresMs = new Date($("#share-expires").value).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs < Date.now() + 5 * 60 * 1000) throw new Error("有効期限は5分以上先に設定してください。");
    const password = $("#share-password").value;
    const token = TRoomCrypto.toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const passwordPackage = await TRoomCrypto.createSharePackage(target.targetKey, password);
    const tokenPackage = await TRoomCrypto.encryptShareToken(token, target.targetKey);
    const selectedFiles = target.type === "selection"
      ? await Promise.all(target.files.map(async (file, index) => ({
          id: Number(file.id),
          position: index,
          ...(index === 0 ? {} : await TRoomCrypto.wrapFileForShare(file.fileKey, target.targetKey))
        })))
      : undefined;
    const result = await api("/shares", {
      method: "POST",
      body: JSON.stringify({
        token,
        targetType: target.type,
        targetId: target.id,
        selectedFiles,
        expiresAt: Math.floor(expiresMs / 1000),
        ...passwordPackage,
        ...tokenPackage
      })
    });
    const url = `${location.origin}${result.sharePath}`;
    $("#share-dialog").close();
    $("#share-result-url").value = url;
    $("#share-result-password").value = password;
    $("#share-result-dialog").showModal();
    try { await copyShareBundle("共有URLを発行し、URLとPWをまとめてコピーしました。"); }
    catch { setNotice("共有URLを発行しました。自動コピーできないため、発行結果からコピーしてください。", true); }
    if (state.view === "shares") await loadItems();
  } catch (error) {
    $("#share-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function clearShareFormSecrets() {
  $("#share-password").value = "";
  $("#share-password").type = "password";
  syncPasswordVisibilityToggle($("#toggle-share-password"));
  $("#generated-share-password").textContent = "";
  $("#generated-share-password").hidden = true;
  state.shareTarget = null;
}

function clearShareResultSecrets() {
  $("#share-result-url").value = "";
  $("#share-result-password").value = "";
}

function formatShareBundle(url, password) {
  return `【T-Cloud Storage 共有】\n\nURL\n${String(url || "")}\n\nパスワード\n${String(password || "")}`;
}

async function copyShareBundle(successMessage = "共有URLとパスワードをまとめてコピーしました。") {
  const url = $("#share-result-url").value;
  const password = $("#share-result-password").value;
  if (!url || !password) throw new Error("コピーする共有情報がありません。");
  await copyText(formatShareBundle(url, password), successMessage);
}

async function stopShare(share) {
  if (!confirm(`「${share.targetName}」の共有URLを直ちに停止しますか？`)) return;
  try {
    await api(`/shares/${share.id}/stop`, { method: "POST", body: "{}" });
    setNotice("共有URLを停止しました。");
    await loadItems();
  } catch (error) { setNotice(error.message, true); }
}

async function openShareEvents(share) {
  try {
    const data = await api(`/shares/${share.id}/events`);
    const events = [];
    for (const original of data.events || []) {
      const item = { ...original, name: "—" };
      if (item.fileId && Number(item.cryptoVersion) === 1) {
        const [file] = await hydrateFileRecords([{ ...item, id: item.fileId, createdAt: item.occurredAt }]);
        item.name = file?.name || "復号できないファイル";
      }
      events.push(item);
    }
    $("#share-events-title").textContent = `${share.targetName} の共有履歴`;
    const list = $("#share-events-list");
    list.innerHTML = "";
    if (!events.length) list.innerHTML = '<p class="share-events-empty">共有先での操作履歴はまだありません。</p>';
    for (const item of events) {
      const row = document.createElement("article");
      const label = ({ unlock_success: "PW認証成功", unlock_failed: "PW認証失敗", download_started: "ダウンロード開始", download_completed: "ダウンロード完了", download_failed: "ダウンロード失敗" })[item.eventType] || item.eventType;
      row.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(item.name)}</span><small>${formatDateTime(item.occurredAt)}${item.errorCode ? ` · ${escapeHtml(item.errorCode)}` : ""}</small>`;
      list.append(row);
    }
    $("#share-events-dialog").showModal();
  } catch (error) { setNotice(error.message, true); }
}

function deletionRequestCard(item) {
  const card = document.createElement("article");
  card.className = "request-card";
  card.innerHTML = `<span class="history-kind">${kindSymbol(item.mediaKind)}</span><span class="history-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.folderName)} · ${item.requestedBy}</small></span><span class="history-meta"><strong>${formatBytes(item.sizeBytes)}</strong><small>${formatDate(item.requestedAt)}</small></span>`;
  const approve = document.createElement("button");
  approve.className = "danger-button request-approve-button";
  approve.type = "button";
  approve.textContent = item.unavailable ? "処理済み" : "削除を承認";
  approve.disabled = item.unavailable;
  approve.addEventListener("click", () => approveDeletionRequest(item));
  card.append(approve);
  return card;
}

function openFolderSettings(folder) {
  if (!canOpenFolderSettings(folder)) {
    setNotice("このフォルダの設定は変更できません。", true);
    return;
  }
  if (folder.isProtected && !folder.isUnlocked) {
    setNotice("先にフォルダのロックを解除してください。", true);
    openFolder(folder);
    return;
  }
  state.selectedFolder = folder;
  $("#folder-settings-id").value = folder.id;
  $("#folder-settings-name").value = folder.name;
  $("#folder-password-action").value = "keep";
  $("#folder-new-password").value = "";
  $("#folder-settings-error").textContent = "";
  $("#delete-folder-button").hidden = !canTrashFolder(folder);
  const inheritsProtection = Boolean(folder.parentId && !folder.isProtected);
  const canEditPassword = canChangeFolderPassword(folder);
  $("#folder-password-settings-row").hidden = !canEditPassword || inheritsProtection;
  $("#folder-password-action").disabled = !canEditPassword || inheritsProtection;
  $("#folder-new-password").disabled = !canEditPassword || inheritsProtection;
  $("#folder-inherited-settings-note").hidden = !canEditPassword || !inheritsProtection;
  toggleFolderPasswordInput();
  $("#folder-settings-dialog").showModal();
}

function toggleFolderPasswordInput() {
  const replace = $("#folder-password-action").value === "replace";
  $("#folder-new-password-row").hidden = !replace;
  $("#folder-new-password").required = replace;
}

async function saveFolderSettings(event) {
  event.preventDefault();
  const id = Number($("#folder-settings-id").value);
  const passwordAction = !canChangeFolderPassword(state.selectedFolder)
    || (state.selectedFolder?.parentId && !state.selectedFolder?.isProtected)
    ? "keep"
    : $("#folder-password-action").value;
  $("#folder-settings-error").textContent = "";
  try {
    const folder = state.selectedFolder;
    const name = cleanEditableName($("#folder-settings-name").value);
    let passwordPackage = {};
    if (passwordAction === "replace") {
      const folderKey = state.crypto.folderKeys.get(id) || (state.session.role === "admin" ? await ensureAdminFolderKey(folder) : null);
      if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
      passwordPackage = await TRoomCrypto.rewrapFolderPassword(folderKey, $("#folder-new-password").value);
    }
    await api(`/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, passwordAction, ...passwordPackage })
    });
    folder.name = name;
    $("#folder-settings-dialog").close();
    setNotice("フォルダ設定を更新しました。");
    invalidateStoredConflicts();
    await loadItems();
  } catch (error) { $("#folder-settings-error").textContent = error.message; }
}

async function deleteSelectedFolder() {
  const folder = state.selectedFolder;
  if (!folder || !canTrashFolder(folder)) return;
  const message = state.session?.canDelete ? `「${folder.name}」を中身ごとゴミ箱へ移動しますか？` : "本当に削除しますか？";
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  const button = $("#delete-folder-button");
  button.disabled = true;
  button.textContent = state.session?.canDelete ? "ゴミ箱へ移動中…" : "削除中…";
  try {
    const result = await api(`/folders/${folder.id}`, { method: "DELETE", body: "{}" });
    await removeDeviceCopiesForFolders([folder]);
    $("#folder-settings-dialog").close();
    setNotice(state.session?.canDelete
      ? `フォルダを中身ごとゴミ箱へ移動しました（合計${Number(result.deleted || 1).toLocaleString("ja-JP")}件）。`
      : "削除しました。");
    invalidateStoredConflicts();
    const reloads = [loadItems()];
    if (state.session?.role === "admin") reloads.push(loadUsage());
    await Promise.all(reloads);
  } catch (error) {
    $("#folder-settings-error").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "削除";
  }
}

async function openFolder(folder) {
  if (Number(folder.cryptoVersion) === 1 && state.session.role === "admin" && !state.crypto.folderKeys.has(folder.id)) {
    try {
      const key = await ensureAdminFolderKey(folder);
      folder.isUnlocked = true;
    } catch (error) {
      setNotice(error.message, true);
      return;
    }
  }
  if (folder.isProtected && !folder.isUnlocked) {
    $("#unlock-folder-id").value = folder.id;
    $("#unlock-folder-name").textContent = folder.name;
    $("#unlock-password").value = "";
    $("#unlock-error").textContent = "";
    $("#unlock-dialog").showModal();
    setTimeout(() => $("#unlock-password").focus(), 50);
    return;
  }
  await navigateToFolder(folder.id, folder.name);
}

function fileCard(file) {
  const card = document.createElement("article");
  card.className = "file-card";
  card.dataset.fileId = String(file.id);
  const button = document.createElement("button");
  button.type = "button";
  const thumbnail = file.hasThumbnail && Number(file.cryptoVersion) !== 1
    ? `<img src="${API}/files/${file.id}/thumbnail" alt="" loading="lazy">`
    : `<span class="media-symbol media-symbol-${escapeHtml(file.mediaKind || "other")}" aria-label="${escapeHtml(kindLabel(file.mediaKind))}">${kindSymbol(file.mediaKind)}</span>`;
  button.innerHTML = `
    <div class="thumb">${thumbnail}</div>
    <div class="file-copy"><strong>${escapeHtml(file.name)}</strong><span class="file-meta"><span class="file-size">${formatMediaDetails(file)}</span><span>${formatDate(file.createdAt || file.deletedAt)}</span></span></div>`;
  button.addEventListener("click", (event) => {
    if (card.dataset.longPressed === "true") {
      card.dataset.longPressed = "false";
      return;
    }
    if (state.selectedFiles.size || state.selectedFolders.size || event.ctrlKey || event.metaKey || event.shiftKey) {
      toggleFileSelection(file, card);
      return;
    }
    file.trashed ? showTrashActions(file) : openPreview(file);
  });
  button.addEventListener("contextmenu", (event) => {
    if (file.trashed) return;
    event.preventDefault();
    selectFile(file, card);
  });
  installLongPressSelection(card, file);
  card.append(button);
  const conflictGroupId = state.conflictFileGroups.get(Number(file.id));
  if (!state.listMode && conflictGroupId && !file.trashed) {
    card.append(createConflictBadge(file, conflictGroupId));
  }
  if (!file.trashed) {
    const selectButton = document.createElement("button");
    selectButton.className = "file-select-button";
    selectButton.type = "button";
    selectButton.setAttribute("aria-label", `${file.name}を選択`);
    selectButton.setAttribute("aria-pressed", state.selectedFiles.has(file.id) ? "true" : "false");
    selectButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFileSelection(file, card);
    });
    card.append(selectButton);
  }
  if (state.selectedFiles.has(file.id)) card.classList.add("selected", "selection-pass");
  if (file.hasThumbnail && Number(file.cryptoVersion) === 1 && file.fileKey) loadEncryptedThumbnail(file, card.querySelector(".thumb"));
  return card;
}

function openFolderRenameDialog(folder) {
  if (!canRenameFolder(folder)) {
    setNotice("PWで解除したフォルダ内の名前だけ変更できます。", true);
    return;
  }
  if (folder.isProtected && !folder.isUnlocked) {
    setNotice("先にフォルダのロックを解除してください。", true);
    openFolder(folder);
    return;
  }
  state.selectedFolder = folder;
  $("#folder-rename-id").value = folder.id;
  $("#folder-rename-name").value = folder.name;
  $("#folder-rename-error").textContent = "";
  $("#folder-rename-dialog").showModal();
  setTimeout(() => $("#folder-rename-name").select(), 50);
}

async function saveFolderName(event) {
  event.preventDefault();
  const folder = state.selectedFolder;
  const id = Number($("#folder-rename-id").value);
  $("#folder-rename-error").textContent = "";
  try {
    if (!folder || Number(folder.id) !== id || !canRenameFolder(folder)) {
      throw new Error("名前を変更するフォルダを確認できません。");
    }
    const name = cleanEditableName($("#folder-rename-name").value);
    await api(`/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, passwordAction: "keep" })
    });
    folder.name = name;
    $("#folder-rename-dialog").close();
    clearFileSelection();
    setNotice("フォルダ名を変更しました。");
    invalidateStoredConflicts();
    await loadItems();
  } catch (error) {
    $("#folder-rename-error").textContent = error.message;
  }
}

function createConflictBadge(file, groupId) {
  const badge = document.createElement("button");
  badge.className = "conflict-badge";
  badge.type = "button";
  badge.textContent = "競合";
  badge.setAttribute("aria-label", `${file.name}の競合候補を確認`);
  badge.addEventListener("pointerdown", (event) => event.stopPropagation());
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    openConflictGroup(groupId);
  });
  return badge;
}

function syncVisibleConflictBadges() {
  $$(".file-card .conflict-badge").forEach((badge) => badge.remove());
  if (state.listMode || state.view !== "all") return;
  for (const file of state.files) {
    const groupId = state.conflictFileGroups.get(Number(file.id));
    const card = $(`.file-card[data-file-id="${Number(file.id)}"]`);
    if (groupId && card && !file.trashed) card.append(createConflictBadge(file, groupId));
  }
}

async function hydrateFileRecords(records, options = {}) {
  const hydrated = [];
  for (const original of records) {
    const file = { ...original };
    if (Number(file.cryptoVersion) === 1) {
      let folderKey = state.crypto.folderKeys.get(Number(file.folderId));
      if (!folderKey && state.session?.role === "admin" && state.crypto.adminPrivateKey && file.folderAdminWrappedKey) {
        const folderRecord = {
          id: file.folderId,
          cryptoVersion: file.folderCryptoVersion,
          encryptedName: file.folderEncryptedName,
          nameIv: file.folderNameIv,
          passwordSalt: file.folderPasswordSalt,
          passwordWrappedKey: file.folderPasswordWrappedKey,
          passwordWrapIv: file.folderPasswordWrapIv,
          adminWrappedKey: file.folderAdminWrappedKey
        };
        try { folderKey = await ensureAdminFolderKey(folderRecord); } catch {}
      }
      if (!folderKey) {
        file.name = "暗号化ファイル";
        file.mimeType = "application/octet-stream";
        file.mediaKind = "other";
      } else {
        try {
          file.fileKey = await TRoomCrypto.unlockFileKey(file, folderKey);
          const metadata = await TRoomCrypto.decryptFileMetadata(file, file.fileKey);
          file.name = metadata.name;
          file.mimeType = metadata.mimeType;
          file.mediaKind = metadata.mediaKind;
          file.lastModified = Number(metadata.lastModified || 0);
          file.durationSeconds = normalizeDurationSeconds(metadata.durationSeconds);
        } catch {
          file.name = "復号できないファイル";
          file.mimeType = "application/octet-stream";
          file.mediaKind = "other";
        }
      }
    }
    hydrated.push(file);
  }
  if (options.preserveOrder) return hydrated;
  let result = hydrated;
  if (state.query) result = result.filter((file) => file.name.toLocaleLowerCase("ja").includes(state.query.toLocaleLowerCase("ja")));
  if (state.kind) result = result.filter((file) => file.mediaKind === state.kind);
  const direction = state.sortDirection === "asc" ? 1 : -1;
  if (state.sortUsesTypeDefaults) result.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  else if (state.sort === "name") result.sort((a, b) => direction * a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
  else if (state.sort === "size") result.sort((a, b) => direction * (Number(a.sizeBytes || 0) - Number(b.sizeBytes || 0)) || a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
  else result.sort((a, b) => direction * String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
  return result;
}

async function hydrateDeletionRequestRecords(records) {
  const hydrated = [];
  for (const original of records) {
    const item = { ...original };
    if (item.fileId && Number(item.cryptoVersion) === 1) {
      const [file] = await hydrateFileRecords([{ ...item, id: item.fileId, createdAt: item.requestedAt }]);
      item.name = file?.name || "復号できないファイル";
      item.mediaKind = file?.mediaKind || "other";
      item.folderName = item.folderName || "フォルダ";
    }
    hydrated.push(item);
  }
  return hydrated;
}

async function hydrateUploadHistoryRecords(records) {
  const hydrated = [];
  for (const original of records) {
    const item = { ...original };
    if (!item.deleted && item.fileId && Number(item.cryptoVersion) === 1) {
      const [file] = await hydrateFileRecords([{ ...item, id: item.fileId, createdAt: item.uploadedAt }]);
      item.name = file?.name || "復号できないファイル";
      item.mediaKind = file?.mediaKind || item.mediaKind || "other";
    }
    hydrated.push(item);
  }
  return hydrated;
}

async function loadEncryptedThumbnail(file, stage) {
  try {
    const response = await fetch(`${API}/files/${file.id}/thumbnail`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const bytes = await TRoomCrypto.decryptThumbnail(await response.arrayBuffer(), file.fileKey);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
    const image = new Image();
    image.alt = "";
    image.loading = "lazy";
    image.onload = () => URL.revokeObjectURL(url);
    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
    stage.replaceChildren(image);
  } catch {}
}

function installLongPressSelection(card, file) {
  let timer = null;
  let started = false;
  let pointerId = null;
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  card.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    started = false;
    timer = setTimeout(() => {
      started = true;
      state.selecting = true;
      card.dataset.longPressed = "true";
      selectFile(file, card);
      if (navigator.vibrate) navigator.vibrate(18);
    }, 380);
  });
  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    if (!started && (Math.abs(event.movementX || 0) > 8 || Math.abs(event.movementY || 0) > 8)) stopTimer();
    if (!state.selecting) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".file-card");
    if (target) {
      const passedFile = state.files.find((item) => String(item.id) === target.dataset.fileId);
      if (passedFile && !passedFile.trashed) selectFile(passedFile, target);
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

function installFolderLongPressSelection(card, folder) {
  let timer = null;
  let started = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  card.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    started = false;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      started = true;
      card.dataset.longPressed = "true";
      selectFolder(folder, card);
      if (navigator.vibrate) navigator.vibrate(18);
    }, 380);
  });
  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) stop();
  });
  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    stop();
    if (started) {
      event.preventDefault();
      setTimeout(() => { card.dataset.longPressed = "false"; }, 0);
    }
    pointerId = null;
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function selectFile(file, card) {
  if (file.trashed || state.selectedFiles.has(file.id)) return;
  beginSelectionHistory();
  state.selectedFiles.set(file.id, file);
  card.classList.add("selected", "selection-pass");
  card.querySelector(".file-select-button")?.setAttribute("aria-pressed", "true");
  syncSelectionBar();
}

function toggleFileSelection(file, card) {
  if (file.trashed) return;
  if (state.selectedFiles.has(file.id)) {
    state.selectedFiles.delete(file.id);
    card.classList.remove("selected", "selection-pass");
    card.querySelector(".file-select-button")?.setAttribute("aria-pressed", "false");
  } else {
    selectFile(file, card);
  }
  syncSelectionBar();
  if (!state.selectedFiles.size && !state.selectedFolders.size && state.selectionHistoryActive) {
    state.selectionHistoryActive = false;
    history.back();
  }
}

function selectFolder(folder, card) {
  if (state.selectedFolders.has(folder.id)) return;
  beginSelectionHistory();
  state.selectedFolders.set(folder.id, folder);
  card.classList.add("selected", "selection-pass");
  card.querySelector(".folder-select-button")?.setAttribute("aria-pressed", "true");
  syncSelectionBar();
}

function toggleFolderSelection(folder, card) {
  if (state.selectedFolders.has(folder.id)) {
    state.selectedFolders.delete(folder.id);
    card.classList.remove("selected", "selection-pass");
    card.querySelector(".folder-select-button")?.setAttribute("aria-pressed", "false");
  } else {
    selectFolder(folder, card);
  }
  syncSelectionBar();
  if (!state.selectedFiles.size && !state.selectedFolders.size && state.selectionHistoryActive) {
    state.selectionHistoryActive = false;
    history.back();
  }
}

function beginSelectionHistory() {
  if (!state.historyReady || state.selectionHistoryActive || state.selectedFiles.size || state.selectedFolders.size) return;
  history.pushState({
    tcloud: true,
    folderId: state.folderId,
    folderName: $("#view-title").textContent,
    previewId: null,
    selection: true
  }, "", location.href);
  state.selectionHistoryActive = true;
}

function selectAllVisibleItems() {
  beginSelectionHistory();
  for (const card of $$("#content-grid .file-card[data-file-id]")) {
    const file = state.files.find((item) => String(item.id) === card.dataset.fileId);
    if (file && !file.trashed) {
      state.selectedFiles.set(file.id, file);
      card.classList.add("selected", "selection-pass");
      card.querySelector(".file-select-button")?.setAttribute("aria-pressed", "true");
    }
  }
  for (const card of $$("#content-grid .folder-card[data-folder-id]")) {
    const folder = state.folders.find((item) => String(item.id) === card.dataset.folderId);
    if (folder) {
      state.selectedFolders.set(folder.id, folder);
      card.classList.add("selected", "selection-pass");
      card.querySelector(".folder-select-button")?.setAttribute("aria-pressed", "true");
    }
  }
  syncSelectionBar();
}

function clearFileSelection(update = true, rewindHistory = update) {
  const hadSelection = Boolean(state.selectedFiles.size || state.selectedFolders.size);
  state.selectedFiles.clear();
  state.selectedFolders.clear();
  state.selecting = false;
  $$(".file-card.selected, .file-card.selection-pass, .folder-card.selected, .folder-card.selection-pass").forEach((card) => {
    card.classList.remove("selected", "selection-pass");
    card.querySelector(".file-select-button, .folder-select-button")?.setAttribute("aria-pressed", "false");
  });
  if (update) syncSelectionBar();
  else $("#selection-bar").hidden = true;
  if (rewindHistory && hadSelection && state.selectionHistoryActive && !state.handlingPopState) {
    state.selectionHistoryActive = false;
    history.back();
  }
}

function syncSelectionBar() {
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  const fileCount = files.length;
  const folderCount = folders.length;
  const count = fileCount + folderCount;
  $("#selection-count").textContent = `${count.toLocaleString("ja-JP")}件を選択中`;
  $("#selection-bar").hidden = count === 0;
  const canRenameSelection = (fileCount === 1 && folderCount === 0 && canRenameFile(files[0]))
    || (folderCount === 1 && fileCount === 0 && canRenameFolder(folders[0]));
  $("#selection-rename").hidden = !canRenameSelection;
  $("#selection-rename").disabled = !canRenameSelection;
  const canChangeSelectedPassword = folderCount === 1
    && fileCount === 0
    && canChangeFolderPassword(folders[0])
    && !(folders[0].parentId && !folders[0].isProtected);
  $("#selection-password").hidden = !canChangeSelectedPassword;
  $("#selection-password").disabled = !canChangeSelectedPassword;
  const canLockSelection = folderCount === 1 && fileCount === 0 && canRelockTopFolder(folders[0]);
  $("#selection-lock").hidden = !canLockSelection;
  $("#selection-lock").disabled = !canLockSelection || state.offlineActive;
  $("#selection-download").disabled = fileCount === 0;
  const canSaveOffline = Boolean(fileCount > 0
    && folderCount === 0
    && files.every((file) => !file.trashed && Number(file.cryptoVersion) === 1 && file.fileKey)
    && currentOfflineContext()
    && globalThis.TCloudOffline?.supported());
  $("#selection-offline").hidden = !canSaveOffline;
  $("#selection-offline").disabled = !canSaveOffline || state.offlineActive;
  $("#selection-offline").textContent = state.offlineActive ? "オフライン保存中…" : "オフライン";
  const canShareSelection = state.session?.role === "admin"
    && ((fileCount >= 1 && folderCount === 0) || (folderCount === 1 && fileCount === 0));
  $("#selection-share").hidden = !canShareSelection;
  const canMoveSelection = Boolean(count && files.every(canMoveFile) && folders.every(canMoveFolder));
  $("#selection-move").hidden = !canMoveSelection;
  $("#selection-move").disabled = !canMoveSelection;
  const canDeleteSelection = Boolean(count
    && files.every(canTrashFile)
    && folders.every(canTrashFolder));
  $("#selection-delete").hidden = !canDeleteSelection;
  $("#selection-delete").disabled = count === 0;
  $("#selection-delete").textContent = "削除";
  if (count) hideFloatingToolbar();
}

function openSelectedRenameDialog() {
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  if (files.length === 1 && folders.length === 0 && canRenameFile(files[0])) {
    state.selected = files[0];
    openEditDialog();
    return;
  }
  if (folders.length === 1 && files.length === 0 && canRenameFolder(folders[0])) {
    openFolderRenameDialog(folders[0]);
  }
}

function openSelectedFolderSettings() {
  const folders = [...state.selectedFolders.values()];
  if (folders.length !== 1
    || state.selectedFiles.size
    || !canChangeFolderPassword(folders[0])
    || (folders[0].parentId && !folders[0].isProtected)) return;
  openFolderSettings(folders[0]);
}

async function lockSelectedTopFolder() {
  const folders = [...state.selectedFolders.values()];
  const folder = folders.length === 1 && !state.selectedFiles.size ? folders[0] : null;
  if (!canRelockTopFolder(folder)) return;
  if (state.offlineActive) {
    setNotice("オフライン保存の完了または停止後にロックしてください。", true);
    return;
  }
  if (!confirm(`「${folder.name}」をロックしますか？\n端末保存したデータは削除されません。`)) return;
  const button = $("#selection-lock");
  button.disabled = true;
  button.textContent = "ロック中…";
  try {
    const result = await api(`/folders/${folder.id}/unlock`, { method: "DELETE", body: "{}" });
    await removeCachedFolderKeys(result.folderIds || [folder.id]);
    state.unlockedTopFolderNames.delete(Number(folder.id));
    syncAccountIdentity();
    clearFileSelection(true, false);
    await loadItems();
    setNotice(`「${folder.name}」をロックしました。`);
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "ロック";
  }
}

function clearSelectionWithoutRefresh() {
  const shouldRewind = Boolean((state.selectedFiles.size || state.selectedFolders.size)
    && state.selectionHistoryActive
    && !state.handlingPopState);
  clearFileSelection(true, false);
  if (!shouldRewind) return;
  state.selectionHistoryActive = false;
  state.selectionClearBackPending = true;
  history.back();
}

async function startSelectedDownloads() {
  const files = [...state.selectedFiles.values()];
  if (!files.length || state.downloadActive) return;
  let targets;
  try {
    targets = await chooseDownloadTargets(files);
  } catch (error) {
    if (error.name !== "AbortError") setNotice(error.message, true);
    return;
  }
  await executeDownloads(files, targets);
}

function currentOfflineContext() {
  if (!state.folderId || !state.breadcrumbs.length || !state.session) return null;
  const rootFolder = state.breadcrumbs[0];
  const rootFolderId = Number(rootFolder?.id || 0);
  const rootFolderKey = state.crypto.folderKeys.get(rootFolderId);
  if (!rootFolderId || !(rootFolderKey instanceof CryptoKey) || !rootFolder.isUnlocked) return null;
  return {
    accountScope: state.session.role === "admin" ? "admin" : "subadmin",
    rootFolder,
    rootFolderId,
    rootFolderKey
  };
}

function attachOfflineStorageIdentity(file, context = currentOfflineContext()) {
  if (!file || !context || !globalThis.TCloudOffline?.supported()) return file;
  const version = String(file.updatedAt || file.createdAt || "1");
  file.offlineAccountScope = context.accountScope;
  file.offlineRootFolderId = context.rootFolderId;
  file.offlineStorageId = TCloudOffline.createStorageId(context.accountScope, context.rootFolderId, file.id, version);
  return file;
}

async function offlineStorageRecord(file, context) {
  attachOfflineStorageIdentity(file, context);
  if (!(file.fileKey instanceof CryptoKey)) throw new Error(`「${file.name}」の暗号化鍵を確認できません。`);
  const wrapped = await TRoomCrypto.rewrapFileForFolder(file.fileKey, context.rootFolderKey);
  return {
    id: file.offlineStorageId,
    accountScope: context.accountScope,
    rootFolderId: context.rootFolderId,
    folderId: Number(file.folderId),
    fileId: Number(file.id),
    version: String(file.updatedAt || file.createdAt || "1"),
    cryptoVersion: Number(file.cryptoVersion || 1),
    encryptedMetadata: file.encryptedMetadata,
    metadataIv: file.metadataIv,
    rootWrappedFileKey: wrapped.wrappedFileKey,
    rootFileKeyIv: wrapped.fileKeyIv,
    sizeBytes: Number(file.sizeBytes || 0),
    encryptedSizeBytes: Number(file.encryptedSizeBytes || file.sizeBytes || 0),
    chunkSizeBytes: Number(file.chunkSizeBytes || 8 * 1024 * 1024),
    chunkCount: Number(file.chunkCount || Math.ceil(Number(file.sizeBytes || 0) / Number(file.chunkSizeBytes || 8 * 1024 * 1024))),
    offline: true,
    complete: false
  };
}

async function saveSelectedOffline() {
  const files = [...state.selectedFiles.values()];
  const context = currentOfflineContext();
  if (!files.length || state.selectedFolders.size || !context || state.offlineActive) return;
  if (!globalThis.TCloudOffline?.supported()) {
    setNotice("このブラウザはオフライン保存に対応していません。", true);
    return;
  }
  state.offlineActive = true;
  state.offlineAbort = new AbortController();
  state.offlineStatus = `保存中：0 / ${files.length.toLocaleString("ja-JP")}件`;
  const progress = createOfflineProgress(files);
  syncSelectionBar();
  let completed = 0;
  const failures = [];
  let progressFinished = false;
  try {
    await syncTransferWakeLock();
    await refreshDeviceStorageSummary();
    const persistence = await TCloudOffline.requestPersistence();
    if (persistence.supported && !persistence.persistent && localStorage.getItem("tcloud-offline-persistence-warning") !== "1") {
      localStorage.setItem("tcloud-offline-persistence-warning", "1");
      setNotice("端末容量が少ない場合、オフラインデータが30日より前に整理される可能性があります。", true);
    }
    for (let index = 0; index < files.length; index += 1) {
      if (state.offlineAbort.signal.aborted) break;
      const file = files[index];
      progress.start(file, index);
      try {
        const record = await offlineStorageRecord(file, context);
        await TCloudMedia.saveOfflineFile(file, record, `${API}/files/${file.id}/view`, {
          signal: state.offlineAbort.signal,
          onProgress: (bytes, total) => {
            const percent = total ? Math.min(100, Math.round(bytes / total * 100)) : 100;
            state.offlineStatus = `保存中：${index + 1} / ${files.length}件・${percent}%`;
            progress.update(bytes, total);
            syncOfflineStatusDisplay();
          }
        });
        completed += 1;
        progress.finishFile(true);
      } catch (error) {
        if (error.name === "AbortError") break;
        failures.push({ name: file.name, message: error.message });
        progress.finishFile(false);
      }
      await refreshDeviceStorageSummary();
    }
    const interrupted = state.offlineAbort.signal.aborted;
    state.offlineStatus = interrupted
      ? `中断：${completed} / ${files.length}件を保存`
      : failures.length
        ? `完了：${completed}件保存・${failures.length}件失敗`
        : `完了：${completed}件をオフライン保存`;
    progress.finish({ completed, failures, interrupted });
    progressFinished = true;
    setNotice(state.offlineStatus, Boolean(failures.length));
  } catch (error) {
    const interrupted = error.name === "AbortError" || state.offlineAbort?.signal.aborted;
    state.offlineStatus = interrupted ? `中断：${completed} / ${files.length}件を保存` : `オフライン保存エラー：${error.message}`;
    if (!progressFinished) progress.finish({ completed, failures: interrupted ? failures : [...failures, { name: "保存処理", message: error.message }], interrupted });
    setNotice(state.offlineStatus, !interrupted);
  } finally {
    state.offlineActive = false;
    state.offlineAbort = null;
    syncSelectionBar();
    await syncTransferWakeLock();
    await refreshDeviceStorageSummary();
  }
}

function cancelOfflineSave() {
  if (!state.offlineAbort || state.offlineAbort.signal.aborted) return;
  $("#offline-cancel").disabled = true;
  $("#offline-activity").textContent = "停止処理中…";
  state.offlineAbort?.abort();
}

function dismissOfflineProgress() {
  if (state.offlineActive) return;
  $("#offline-panel").hidden = true;
}

function createOfflineProgress(files) {
  const panel = $("#offline-panel");
  const totalBytes = files.reduce((sum, file) => sum + Number(file.encryptedSizeBytes || file.sizeBytes || 0), 0);
  const startedAt = performance.now();
  const samples = [];
  let settledBytes = 0;
  let currentBytes = 0;
  let currentTotal = 0;
  let currentInitialized = false;
  let transferredBytes = 0;
  let lastActivityAt = startedAt;
  let timer = null;

  panel.hidden = false;
  panel.classList.remove("upload-complete", "upload-error");
  $("#offline-heading").textContent = "オフライン保存中";
  $("#offline-count").textContent = `0 / ${files.length}件`;
  $("#offline-progress").style.width = "0%";
  $("#offline-file-name").textContent = "保存準備中";
  $("#offline-speed").textContent = "速度計測中";
  $("#offline-percent").textContent = "0%";
  $("#offline-bytes").textContent = `0 B / ${formatBytes(totalBytes)}`;
  $("#offline-eta").textContent = "残り時間：計算中";
  $("#offline-activity").textContent = "保存準備中";
  $("#offline-activity").classList.remove("waiting");
  $("#offline-cancel").hidden = false;
  $("#offline-cancel").disabled = false;
  $("#offline-dismiss").hidden = true;
  $("#offline-failure-summary").hidden = true;
  $("#offline-failed-list").replaceChildren();

  const refresh = () => {
    const now = performance.now();
    const savedBytes = Math.min(totalBytes, settledBytes + currentBytes);
    const percent = totalBytes ? Math.min(100, savedBytes / totalBytes * 100) : 100;
    while (samples.length > 2 && samples[0].time < now - 8000) samples.shift();
    const first = samples[0];
    const last = samples.at(-1);
    const seconds = first && last ? Math.max(.25, (last.time - first.time) / 1000) : 0;
    const bytesPerSecond = seconds > 0 ? Math.max(0, (last.bytes - first.bytes) / seconds) : 0;
    const remainingSeconds = bytesPerSecond > 0 ? Math.max(0, totalBytes - savedBytes) / bytesPerSecond : 0;
    $("#offline-progress").style.width = `${percent}%`;
    $("#offline-percent").textContent = `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
    $("#offline-speed").textContent = bytesPerSecond > 0 ? formatTransferRate(bytesPerSecond) : "速度計測中";
    $("#offline-bytes").textContent = `${formatBytes(savedBytes)} / ${formatBytes(totalBytes)}`;
    $("#offline-eta").textContent = bytesPerSecond > 0 && savedBytes < totalBytes
      ? `残り約${formatTransferDuration(remainingSeconds)}`
      : (savedBytes >= totalBytes ? "保存完了" : "残り時間：計算中");
    const idleSeconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
    const waiting = currentInitialized && idleSeconds >= 15;
    $("#offline-activity").textContent = waiting ? `通信応答待ち・最終通信${idleSeconds}秒前` : "端末へ保存中";
    $("#offline-activity").classList.toggle("waiting", waiting);
  };
  timer = setInterval(refresh, 1000);

  return {
    start(file, index) {
      currentBytes = 0;
      currentTotal = Number(file.encryptedSizeBytes || file.sizeBytes || 0);
      currentInitialized = false;
      lastActivityAt = performance.now();
      $("#offline-count").textContent = `${index + 1} / ${files.length}件`;
      $("#offline-file-name").textContent = file.name;
      $("#offline-activity").textContent = "保存準備中";
      refresh();
    },
    update(bytes, total) {
      const nextBytes = Math.max(0, Number(bytes || 0));
      currentTotal = Math.max(0, Number(total || currentTotal));
      if (currentInitialized) transferredBytes += Math.max(0, nextBytes - currentBytes);
      else currentInitialized = true;
      currentBytes = nextBytes;
      lastActivityAt = performance.now();
      samples.push({ time: lastActivityAt, bytes: transferredBytes });
      refresh();
    },
    finishFile(completed) {
      settledBytes += completed ? currentTotal : currentBytes;
      currentBytes = 0;
      currentTotal = 0;
      currentInitialized = false;
      refresh();
    },
    finish({ completed, failures, interrupted }) {
      clearInterval(timer);
      timer = null;
      $("#offline-heading").textContent = interrupted ? "オフライン保存を停止しました" : failures.length ? "一部のオフライン保存に失敗しました" : "オフライン保存が完了しました";
      $("#offline-count").textContent = `${completed} / ${files.length}件保存`;
      $("#offline-activity").textContent = interrupted ? "保存済み部分は次回の再開に利用します" : failures.length ? `${failures.length}件を保存できませんでした` : "完了";
      $("#offline-cancel").hidden = true;
      $("#offline-dismiss").hidden = false;
      panel.classList.toggle("upload-complete", !interrupted && !failures.length);
      panel.classList.toggle("upload-error", Boolean(failures.length));
      if (failures.length) {
        const list = $("#offline-failed-list");
        list.replaceChildren(...failures.map((failure) => {
          const item = document.createElement("li");
          item.textContent = `${failure.name} — ${failure.message}`;
          return item;
        }));
        $("#offline-failure-summary").hidden = false;
      }
    }
  };
}

function syncOfflineStatusDisplay() {
  const status = $("#device-storage-status");
  status.hidden = !state.offlineStatus;
  status.textContent = state.offlineStatus;
  $("#cancel-offline-save").hidden = !state.offlineActive;
}

async function deleteSelectedItems() {
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  const count = files.length + folders.length;
  if (!count) return;
  if (!files.every(canTrashFile) || !folders.every(canTrashFolder)) {
    setNotice("PWで解除した最初のフォルダ配下だけ削除できます。", true);
    return;
  }
  const folderNote = folders.length ? "\nフォルダは中身ごとゴミ箱へ移動します。" : "";
  const message = state.session?.canDelete
    ? `${count}件を削除しますか？ファイルはゴミ箱へ移動します。${folderNote}`
    : "本当に削除しますか？";
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  const button = $("#selection-delete");
  button.disabled = true;
  button.textContent = `削除中 0 / ${count}`;
  let completed = 0;
  let movedEntries = 0;
  let processed = 0;
  const deletedFiles = [];
  const failures = [];
  try {
    const deletionQueue = [
      ...folders.map((folder) => ({ type: "folder", item: folder })),
      ...files.map((file) => ({ type: "file", item: file }))
    ];
    let nextDeletionIndex = 0;
    const deletionWorker = async () => {
      while (nextDeletionIndex < deletionQueue.length) {
        const task = deletionQueue[nextDeletionIndex++];
        try {
          const result = await api(`/${task.type === "folder" ? "folders" : "files"}/${task.item.id}`, {
            method: "DELETE",
            body: "{}"
          });
          completed += 1;
          movedEntries += task.type === "folder" ? Number(result.deleted || 1) : 1;
          if (task.type === "file") deletedFiles.push(task.item);
        } catch (error) {
          failures.push({ name: task.item.name, error });
        }
        processed += 1;
        button.textContent = `削除中 ${processed} / ${count}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, deletionQueue.length) }, () => deletionWorker()));
    clearFileSelection();
    const failedNames = failures.slice(0, 3).map((item) => item.name).join("、");
    const successMessage = state.session?.canDelete
      ? `${completed}件の選択から、合計${movedEntries.toLocaleString("ja-JP")}件をゴミ箱へ移動しました。`
      : `${completed}件を削除しました。`;
    setNotice(failures.length
      ? `${completed}件を処理しました。削除できなかった${failures.length}件：${failedNames}${failures.length > 3 ? " ほか" : ""}`
      : successMessage, Boolean(failures.length));
    if (completed) invalidateStoredConflicts();
    if (deletedFiles.length) await removeDeviceCopiesForFiles(deletedFiles);
    if (folders.length) await removeDeviceCopiesForFolders(folders);
    const reloads = [loadItems()];
    if (state.session?.role === "admin") reloads.push(loadUsage());
    await Promise.all(reloads);
  } finally {
    button.disabled = false;
    syncSelectionBar();
  }
}

async function openMoveDialog() {
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  if (!files.length && !folders.length) return;
  if (!files.every(canMoveFile) || !folders.every(canMoveFolder)) {
    setNotice("PWで解除した最上位フォルダの配下だけ移動できます。", true);
    return;
  }
  const select = $("#move-destination");
  const submit = $("#move-submit");
  $("#move-error").textContent = "";
  $("#move-copy").textContent = `${files.length + folders.length}件の移動先を選択してください。`;
  select.innerHTML = '<option value="">読み込み中…</option>';
  select.disabled = true;
  submit.disabled = true;
  $("#move-dialog").showModal();
  try {
    const scopeRoot = state.session?.role === "admin" ? null : unlockedMoveScopeRoot();
    if (state.session?.role !== "admin" && !scopeRoot) {
      throw new Error("移動元のPW解除済みフォルダを確認できません。");
    }
    const params = new URLSearchParams();
    if (scopeRoot) params.set("scopeRootId", String(scopeRoot.id));
    const query = params.toString();
    const data = await api(`/move-destinations${query ? `?${query}` : ""}`);
    const destinations = buildMoveDestinations(data.folders || [], scopeRoot);
    const selectedFolderIds = new Set(folders.map((folder) => Number(folder.id)));
    state.moveDestinations.clear();
    select.innerHTML = "";
    if (!files.length) select.append(new Option("Cloud Storage（最上位）", "root"));
    for (const destination of destinations) {
      if (selectedFolderIds.has(destination.folder.id) || destination.ancestorIds.some((id) => selectedFolderIds.has(id))) continue;
      state.moveDestinations.set(Number(destination.folder.id), destination.folder);
      select.append(new Option(destination.label, String(destination.folder.id)));
    }
    if (!select.options.length) throw new Error("選択できる移動先がありません。");
    select.disabled = false;
    submit.disabled = false;
  } catch (error) {
    select.innerHTML = '<option value="">移動先を読み込めませんでした</option>';
    $("#move-error").textContent = error.message;
  }
}

function buildMoveDestinations(records, scopeRoot = null) {
  const folders = records.map((folder) => ({ ...folder }));
  const children = new Map();
  for (const folder of folders) {
    const parentId = folder.parentId == null ? null : Number(folder.parentId);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(folder);
  }
  for (const entries of children.values()) {
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja", { numeric: true, sensitivity: "base" }));
  }
  const output = [];
  const visit = (folder, path, ancestorIds) => {
    const nextPath = [...path, folder.name];
    output.push({ folder, label: nextPath.join(" / "), ancestorIds: [...ancestorIds] });
    for (const child of children.get(Number(folder.id)) || []) {
      visit(child, nextPath, [...ancestorIds, Number(folder.id)]);
    }
  };
  if (scopeRoot) {
    const root = folders.find((folder) => Number(folder.id) === Number(scopeRoot.id));
    if (!root) throw new Error("移動可能なフォルダを確認できませんでした。");
    visit(root, [], []);
  } else {
    for (const root of children.get(null) || []) visit(root, [], []);
  }
  return output;
}

async function loadMoveDestination(folderId) {
  const data = await api(`/items?folderId=${Number(folderId)}&foldersOnly=1`);
  const breadcrumbs = await hydrateFolderRecords(data.breadcrumbs || [], { preserveOrder: true });
  const destination = breadcrumbs.find((folder) => Number(folder.id) === Number(folderId));
  if (!destination) throw new Error("移動先フォルダを確認できませんでした。");
  state.moveDestinations.set(Number(destination.id), destination);
  return destination;
}

async function moveSelectedItems(event) {
  event.preventDefault();
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  const value = $("#move-destination").value;
  const destinationId = value === "root" ? null : Number(value);
  if (files.length && !destinationId) {
    $("#move-error").textContent = "ファイルはフォルダ内へ移動してください。";
    return;
  }
  let destination = destinationId ? state.moveDestinations.get(destinationId) : null;
  const submit = $("#move-submit");
  submit.disabled = true;
  submit.textContent = "移動中…";
  let completed = 0;
  let failed = 0;
  try {
    if (destinationId) destination = await loadMoveDestination(destinationId);
    const destinationKey = destination
      ? (state.crypto.folderKeys.get(Number(destination.id)) || (state.session?.role === "admin" ? await ensureAdminFolderKey(destination) : null))
      : null;
    if (destination && !destinationKey) throw new Error("移動先フォルダのPWを解除してください。");
    for (const file of files) {
      try {
        if (!file.fileKey || !destinationKey) throw new Error("ファイル鍵を確認できません。");
        const wrapped = await TRoomCrypto.rewrapFileForFolder(file.fileKey, destinationKey);
        await api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ folderId: destinationId, ...wrapped }) });
        completed += 1;
      } catch {
        failed += 1;
      }
    }
    for (const folder of folders) {
      try {
        if (!destinationId && !folder.isProtected) throw new Error("PWを持たないフォルダは最上位へ移動できません。");
        const folderKey = state.crypto.folderKeys.get(Number(folder.id)) || (state.session?.role === "admin" ? await ensureAdminFolderKey(folder) : null);
        if (!folderKey) throw new Error("移動するフォルダのPWを解除してください。");
        const parentPackage = destinationKey ? await TRoomCrypto.rewrapFolderForParent(folderKey, destinationKey) : {};
        await api(`/folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name: folder.name, passwordAction: "keep", parentId: destinationId, ...parentPackage }) });
        completed += 1;
      } catch {
        failed += 1;
      }
    }
    $("#move-dialog").close();
    clearFileSelection();
    setNotice(failed ? `${completed}件を移動しました。${failed}件は移動できませんでした。` : `${completed}件を移動しました。`, Boolean(failed));
    if (completed) invalidateStoredConflicts();
    await loadItems();
  } catch (error) {
    $("#move-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "移動する";
  }
}

async function downloadCurrentFolder() {
  if (!state.folderId || state.downloadActive || !("showDirectoryPicker" in window)) return;
  let destination;
  try {
    destination = await TCloudMedia.chooseDownloadDirectory();
  } catch (error) {
    if (error.name !== "AbortError") setNotice(error.message, true);
    return;
  }
  try {
    const folderKey = state.crypto.folderKeys.get(Number(state.folderId));
    if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
    setNotice("フォルダ内のデータを確認しています。");
    const files = await collectFolderDownloads(Number(state.folderId), folderKey);
    if (!files.length) {
      setNotice("このフォルダにダウンロードできるファイルはありません。");
      return;
    }
    const rootHandle = await createUniqueDirectoryHandle(destination, $("#view-title").textContent);
    const targets = new Map();
    for (const file of files) {
      let directory = rootHandle;
      for (const name of file.downloadDirectories || []) {
        directory = await directory.getDirectoryHandle(TCloudMedia.safeFilename(name), { create: true });
      }
      targets.set(file.id, await directory.getFileHandle(TCloudMedia.safeFilename(file.name), { create: true }));
    }
    setNotice("");
    await executeDownloads(files, targets);
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function collectFolderDownloads(folderId, folderKey, downloadDirectories = [], output = []) {
  state.crypto.folderKeys.set(Number(folderId), folderKey);
  const params = new URLSearchParams({ folderId: String(folderId), sort: "oldest" });
  const data = await api(`/items?${params}`);
  const folders = await hydrateFolderRecords(data.folders || []);
  const files = await hydrateFileRecords(data.files || []);
  for (const file of files) {
    output.push({ ...file, downloadDirectories, downloadDisplayName: [...downloadDirectories, file.name].join("/") });
  }
  for (const folder of folders) {
    const childKey = state.crypto.folderKeys.get(Number(folder.id));
    if (!childKey) throw new Error(`「${folder.name}」のロックを解除してから、もう一度お試しください。`);
    await collectFolderDownloads(Number(folder.id), childKey, [...downloadDirectories, folder.name], output);
  }
  return output;
}

async function createUniqueDirectoryHandle(parentHandle, requestedName) {
  const safeName = TCloudMedia.safeFilename(requestedName || "T-Cloud Download");
  for (let suffix = 0; suffix < 1000; suffix++) {
    const name = suffix ? `${safeName} (${suffix})` : safeName;
    try {
      await parentHandle.getDirectoryHandle(name);
    } catch (error) {
      if (error.name === "NotFoundError") return parentHandle.getDirectoryHandle(name, { create: true });
      if (error.name === "TypeMismatchError") continue;
      throw error;
    }
  }
  throw new Error("保存先フォルダを作成できませんでした。");
}

async function executeDownloads(files, targets) {
  state.downloadActive = true;
  state.downloadAbort = new AbortController();
  syncAvailableActions();
  renderDownloadQueue(files);
  $("#download-dialog").showModal();
  $("#download-cancel").hidden = false;
  $("#download-close").disabled = true;
  await syncTransferWakeLock();
  let completed = 0;
  let deferred = [];
  let activeFile = null;
  let closeOnSuccess = false;
  try {
    for (const file of files) {
      if (state.downloadAbort.signal.aborted) throw new DOMException("中止しました", "AbortError");
      activeFile = file;
      $("#download-current").textContent = file.downloadDisplayName || file.name;
      updateDownloadQueueItem(file.id, "処理中", "");
      await recordDownloadEvent(file.id, "download_started");
      try {
        await downloadFile(file, state.downloadAbort.signal, targets.get(file.id) || null);
        await recordDownloadEvent(file.id, "download_completed");
        completed++;
        activeFile = null;
        updateDownloadQueueItem(file.id, "完了", "done");
        updateDownloadProgress(completed, files.length);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        deferred.push({ file, error });
        activeFile = null;
        updateDownloadQueueItem(file.id, "後で再試行", "failed");
      }
    }
    if (deferred.length) {
      $("#download-summary").textContent = "エラー分を再試行しています";
      const retryFailures = [];
      for (const item of deferred) {
        if (state.downloadAbort.signal.aborted) throw new DOMException("中止しました", "AbortError");
        const { file } = item;
        activeFile = file;
        $("#download-current").textContent = `${file.downloadDisplayName || file.name}を再試行中`;
        updateDownloadQueueItem(file.id, "再試行中", "");
        try {
          await downloadFile(file, state.downloadAbort.signal, targets.get(file.id) || null);
          await recordDownloadEvent(file.id, "download_completed");
          completed++;
          activeFile = null;
          updateDownloadQueueItem(file.id, "完了", "done");
          updateDownloadProgress(completed, files.length);
        } catch (error) {
          if (error.name === "AbortError") throw error;
          retryFailures.push({ file, error });
          activeFile = null;
          updateDownloadQueueItem(file.id, "エラー", "failed");
          await recordDownloadEvent(file.id, "download_failed", error.message);
        }
      }
      deferred = retryFailures;
    }
    if (deferred.length) {
      $("#download-summary").textContent = `${completed}件完了、${deferred.length}件エラー`;
      $("#download-current").textContent = "保存できなかったデータを下にまとめました。";
      renderTransferFailures("#download-failure-summary", "#download-failed-list", deferred);
    } else {
      $("#download-summary").textContent = `${completed}件の保存が完了しました`;
      $("#download-current").textContent = "選択した保存先をご確認ください。";
      closeOnSuccess = true;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      if (activeFile) await recordDownloadEvent(activeFile.id, "download_failed", "cancelled");
      $("#download-summary").textContent = "ダウンロードを中止しました";
      $("#download-current").textContent = "未処理のファイルは保存されません。";
    }
  } finally {
    state.downloadActive = false;
    state.downloadAbort = null;
    syncAvailableActions();
    await syncTransferWakeLock();
    $("#download-cancel").hidden = true;
    $("#download-close").disabled = false;
    clearFileSelection();
    if (closeOnSuccess && $("#download-dialog").open) $("#download-dialog").close();
  }
}

async function recordDownloadEvent(fileId, eventType, errorCode = "") {
  try {
    await api("/download-events", {
      method: "POST",
      body: JSON.stringify({ fileId, eventType, errorCode: String(errorCode || "").slice(0, 80) })
    });
  } catch {
    // 履歴保存の失敗で、ファイル本体のダウンロードは止めない。
  }
}

async function chooseDownloadTargets(files) {
  const result = new Map();
  const encrypted = files.filter((file) => Number(file.cryptoVersion) === 1);
  if (!encrypted.length) return result;
  if (encrypted.length > 1 && "showDirectoryPicker" in window) {
    const directory = await TCloudMedia.chooseDownloadDirectory();
    for (const file of encrypted) {
      result.set(file.id, await directory.getFileHandle(TCloudMedia.safeFilename(file.name), { create: true }));
    }
    return result;
  }
  if (encrypted.length === 1 && "showSaveFilePicker" in window) {
    result.set(encrypted[0].id, await TCloudMedia.chooseDownloadTarget(encrypted[0]));
    return result;
  }
  if (encrypted.some((file) => Number(file.sizeBytes) > 512 * 1024 * 1024)) {
    throw new Error("このブラウザでは大容量ファイルの直接保存に対応していません。最新版のChromeまたはEdgeをご利用ください。");
  }
  return result;
}

async function downloadFile(file, signal, targetHandle) {
  if (Number(file.cryptoVersion) === 1) {
    if (!file.fileKey) throw new Error("ファイルの暗号化鍵を解除できません。");
    const endpoint = `${API}/files/${file.id}/view`;
    if (targetHandle) {
      await TCloudMedia.streamDownload(file, file.fileKey, endpoint, targetHandle, {
        signal,
        onProgress: (done, total) => {
          const percent = total ? Math.round(done / total * 100) : 100;
          updateDownloadQueueItem(file.id, `${percent}%`, "");
          $("#download-current").textContent = `${file.name} — ${formatBytes(done)} / ${formatBytes(total)}`;
        }
      });
      return;
    }
    const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, endpoint, { signal });
    saveBlob(blob, file.name);
    return;
  }
  // Large files are handed to the browser's native download manager so the
  // page does not have to retain gigabytes of data in memory.
  if (Number(file.sizeBytes || 0) > 64 * 1024 * 1024) {
    const link = document.createElement("a");
    link.href = `${API}/files/${file.id}/download`;
    link.download = file.name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 700);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("中止しました", "AbortError")); }, { once: true });
    });
    return;
  }
  const response = await fetch(`${API}/files/${file.id}/download`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) {
    let message = `通信に失敗しました（${response.status}）`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const blob = await response.blob();
  if (signal.aborted) throw new DOMException("中止しました", "AbortError");
  saveBlob(blob, file.name);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function renderDownloadQueue(files) {
  $("#download-queue").innerHTML = files.map((file) => `<li data-download-id="${file.id}"><span>${escapeHtml(file.downloadDisplayName || file.name)}</span><span>待機中</span></li>`).join("");
  $("#download-summary").textContent = `${files.length}件を準備しています`;
  $("#download-current").textContent = "";
  renderTransferFailures("#download-failure-summary", "#download-failed-list", []);
  updateDownloadProgress(0, files.length);
}

function renderTransferFailures(summarySelector, listSelector, failures) {
  const summary = $(summarySelector);
  const list = $(listSelector);
  if (!summary || !list) return;
  summary.hidden = !failures.length;
  list.innerHTML = failures.map(({ file, error, displayName }) => `<li><strong>${escapeHtml(displayName || file.downloadDisplayName || file.name)}</strong>${error?.message ? ` — ${escapeHtml(error.message)}` : ""}</li>`).join("");
}

function renderUploadConflicts(conflicts) {
  const summary = $("#upload-conflict-summary");
  const list = $("#upload-conflict-list");
  if (!summary || !list) return;
  summary.hidden = !conflicts.length;
  list.innerHTML = conflicts.map((item) => {
    const details = item.kind === "selection"
      ? [`${Number(item.duplicateCount || 2)}件すべてを保留しました。`]
      : (item.existingLocations || []).map((location) => `保存済み：${location}`);
    return `<li><strong>${escapeHtml(item.displayName || item.file?.name || "名称なし")}</strong><span>${escapeHtml(item.reason || "競合候補です。")}</span>${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}</li>`;
  }).join("");
}

function updateDownloadQueueItem(id, label, className) {
  const node = $(`[data-download-id="${id}"] span:last-child`);
  if (!node) return;
  node.textContent = label;
  node.className = className;
}

function updateDownloadProgress(done, total) {
  const percent = total ? Math.round(done / total * 100) : 0;
  $("#download-progress").style.width = `${percent}%`;
  $("#download-percent").textContent = `${percent}%`;
}

function cancelDownloads() {
  state.downloadAbort?.abort();
}

function closeDownloadDialog() {
  if (state.downloadActive) return;
  $("#download-dialog").close();
}

function uploadKeepsScreenAwake() {
  return Boolean(state.uploading || state.activeFolderUploadOperationId || state.offlineActive);
}

function downloadKeepsScreenAwake() {
  return Boolean(state.downloadActive && $("#keep-screen-awake")?.checked);
}

function shouldKeepScreenAwake() {
  return uploadKeepsScreenAwake() || downloadKeepsScreenAwake();
}

function setTransferWakeLockStatus(message, status = "idle") {
  const uploadStatus = $("#upload-wake-lock-status");
  if (uploadStatus) {
    uploadStatus.textContent = message;
    uploadStatus.dataset.status = status;
  }
  const downloadStatus = $("#wake-lock-status");
  if (downloadStatus) downloadStatus.textContent = message;
  const offlineStatus = $("#offline-wake-lock-status");
  if (offlineStatus) {
    offlineStatus.textContent = message;
    offlineStatus.dataset.status = status;
  }
}

async function requestTransferWakeLock() {
  $("#download-retry-wake").hidden = true;
  if (!shouldKeepScreenAwake()) return false;
  if (!("wakeLock" in navigator)) {
    setTransferWakeLockStatus("消灯防止を開始できませんでした。端末の画面設定をご確認ください。", "error");
    return false;
  }
  if (document.visibilityState !== "visible") {
    setTransferWakeLockStatus("画面へ戻ると消灯防止を再開します。", "waiting");
    return false;
  }
  if (state.wakeLock && !state.wakeLock.released) {
    setTransferWakeLockStatus("消灯防止中", "active");
    return true;
  }
  if (state.wakeLockRequest) return state.wakeLockRequest;

  state.wakeLockRequest = (async () => {
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!shouldKeepScreenAwake() || document.visibilityState !== "visible") {
        try { await lock.release(); } catch {}
        return false;
      }
      state.wakeLock = lock;
      lock.addEventListener("release", () => {
        if (state.wakeLock === lock) state.wakeLock = null;
        if (!shouldKeepScreenAwake()) {
          setTransferWakeLockStatus("消灯防止を終了しました。", "idle");
        } else if (document.visibilityState !== "visible") {
          setTransferWakeLockStatus("画面へ戻ると消灯防止を再開します。", "waiting");
        } else {
          setTransferWakeLockStatus("消灯防止が解除されました。画面へ戻ると再開します。", "waiting");
          $("#download-retry-wake").hidden = !state.downloadActive;
        }
      }, { once: true });
      setTransferWakeLockStatus("消灯防止中", "active");
      return true;
    } catch {
      setTransferWakeLockStatus("消灯防止を開始できませんでした。省電力設定などをご確認ください。", "error");
      $("#download-retry-wake").hidden = !state.downloadActive;
      return false;
    }
  })();
  try {
    return await state.wakeLockRequest;
  } finally {
    state.wakeLockRequest = null;
  }
}

async function releaseTransferWakeLock() {
  if (state.wakeLockRequest) {
    try { await state.wakeLockRequest; } catch {}
  }
  if (state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    try { await lock.release(); } catch {}
  }
  setTransferWakeLockStatus("消灯防止を終了しました。", "idle");
  $("#download-retry-wake").hidden = true;
}

async function syncTransferWakeLock() {
  if (shouldKeepScreenAwake()) return requestTransferWakeLock();
  await releaseTransferWakeLock();
  return false;
}

async function handleTransferVisibility() {
  if (document.visibilityState === "visible" && shouldKeepScreenAwake()) {
    await requestTransferWakeLock();
  } else if (shouldKeepScreenAwake()) {
    setTransferWakeLockStatus("画面へ戻ると消灯防止を再開します。", "waiting");
  }
}

function renderBreadcrumbs(items) {
  const nav = $("#breadcrumbs");
  if (state.view === "trash") { state.breadcrumbs = []; nav.textContent = "完全削除または復元するまで、ファイルはゴミ箱に保持されます。"; renderFloatingLocation([]); return; }
  if (state.view === "conflicts") { state.breadcrumbs = []; nav.textContent = state.session?.role === "subadmin" ? "PWを解除したトップフォルダごとに、配下の競合候補を確認します。" : "トップフォルダの境界を越えず、各フォルダ配下の競合候補を確認します。"; renderFloatingLocation([]); return; }
  if (state.view === "history") { state.breadcrumbs = []; nav.textContent = state.session?.role === "admin" ? "管理者・副管理者のアップロード／ダウンロード履歴です。" : "副管理者本人のアップロード／ダウンロード履歴です。"; renderFloatingLocation([]); return; }
  if (state.view === "requests") { state.breadcrumbs = []; nav.textContent = "承認するまでファイルは削除されず、通常どおり利用できます。"; renderFloatingLocation([]); return; }
  if (state.view === "shares") { state.breadcrumbs = []; nav.textContent = "共有URLの発行状況・期限・停止・利用履歴を管理できます。"; renderFloatingLocation([]); return; }
  renderFloatingLocation(items);
  nav.innerHTML = "";
  const home = document.createElement("button");
  home.type = "button";
  home.textContent = "Cloud Storage";
  home.addEventListener("click", () => navigateToFolder(null, "フォルダ"));
  nav.append(home);
  for (const item of items) {
    const span = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.name;
    button.addEventListener("click", () => navigateToFolder(item.id, item.name));
    span.append(button);
    nav.append(span);
  }
}

async function uploadSelectedFolder(event) {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const selection = state.folderUploadSelection;
  if (!selection) {
    $("#folder-upload-error").textContent = "アップロードするフォルダを選択してください。";
    return;
  }
  if (state.uploading || state.activeFolderUploadOperationId) {
    const message = "現在のアップロードが完了してから、もう一度お試しください。";
    $("#folder-upload-error").textContent = message;
    setNotice(message, true);
    return;
  }
  const operationId = ++state.folderUploadOperationSequence;
  const topLevelPassword = state.folderId ? "" : $("#folder-upload-password").value;
  state.activeFolderUploadOperationId = operationId;
  state.uploading = true;
  submitButton.disabled = true;
  submitButton.textContent = "準備中…";
  state.folderUploadSelection = null;
  $("#folder-upload-dialog").close();
  $("#folder-upload-password").value = "";
  $("#folder-upload-error").textContent = "";
  syncAvailableActions();
  const panel = $("#upload-panel");
  panel.hidden = false;
  panel.classList.remove("upload-complete", "upload-error");
  $("#upload-heading").textContent = "アップロード内容を確認中";
  $("#upload-status").textContent = `0 / ${selection.directories.length}フォルダ確認`;
  $("#upload-file-name").textContent = selection.roots.join("、");
  $("#upload-file-progress").textContent = "準備中…";
  $("#upload-progress").style.width = "0%";
  $("#upload-plan-summary").hidden = true;
  renderUploadConflicts([]);
  $("#upload-dismiss").hidden = true;
  await syncTransferWakeLock();
  await waitForInterfacePaint();
  try {
    if (state.activeFolderUploadOperationId !== operationId) return;
    if (!state.crypto.publicKey || !state.crypto.fileEncryptionReady) throw new Error("暗号化の初期設定を完了してください。");
    const baseParentId = state.folderId ? Number(state.folderId) : null;
    const baseParentKey = baseParentId ? state.crypto.folderKeys.get(baseParentId) : null;
    if (baseParentId && !baseParentKey) throw new Error("保存先フォルダの暗号化鍵を解除してください。");

    const plan = await planFolderUpload(selection, baseParentId, baseParentKey, operationId);
    if (state.activeFolderUploadOperationId !== operationId) return;
    const zeroByteCount = plan.pendingFiles.filter((file) => Number(file.size) === 0).length;
    const actualFileCount = plan.pendingFiles.length - zeroByteCount;
    $("#upload-heading").textContent = "差分確認完了";
    $("#upload-status").textContent = `${plan.newFolderCount}フォルダ・${actualFileCount}ファイルを追加`;
    $("#upload-file-progress").textContent = `${plan.reusedFolderCount}フォルダを再利用・${plan.duplicateSkipped.length}ファイルを競合候補として保留${zeroByteCount ? `・${zeroByteCount}件は空ファイル` : ""}`;
    showUploadPlanSummary(plan.newFolderCount, actualFileCount, plan.reusedFolderCount, plan.duplicateSkipped.length, zeroByteCount);
    renderUploadConflicts(plan.duplicateSkipped);
    $("#upload-progress").style.width = "100%";
    await waitForInterfacePaint();

    const foldersByPath = new Map();
    let createdFolderCount = 0;
    for (let index = 0; index < selection.directories.length; index++) {
      if (state.activeFolderUploadOperationId !== operationId) return;
      const path = selection.directories[index];
      const folderPlan = plan.foldersByPath.get(path);
      if (folderPlan.existing) {
        foldersByPath.set(path, { id: folderPlan.id, key: folderPlan.key, reused: true });
        continue;
      }
      const parentPath = folderPlan.parentPath;
      const inheritedParent = parentPath ? foldersByPath.get(parentPath) : { id: baseParentId, key: baseParentKey };
      if (!inheritedParent) throw new Error(`${path} の親フォルダを作成できませんでした。`);
      $("#upload-heading").textContent = "新しいフォルダを作成中";
      const folderPassword = !baseParentId && !folderPlan.parentPath ? topLevelPassword : "";
      const created = await createEncryptedFolder(folderPlan.name, inheritedParent.id, inheritedParent.key, folderPassword);
      foldersByPath.set(path, created);
      createdFolderCount++;
      $("#upload-status").textContent = `${createdFolderCount} / ${plan.newFolderCount}フォルダ作成`;
    }

    const destinations = new Map();
    for (const record of selection.files) {
      const folderPath = record.relativePath.split("/").slice(0, -1).join("/");
      const destination = foldersByPath.get(folderPath);
      if (!destination) throw new Error(`${record.relativePath} の保存先を作成できませんでした。`);
      destinations.set(record.file, { folderId: destination.id, folderKey: destination.key, displayName: record.relativePath });
    }
    for (const file of selection.looseFiles || []) {
      if (!baseParentId || !baseParentKey) throw new Error("単独ファイルの保存先フォルダを開いてから、もう一度ドロップしてください。");
      destinations.set(file, { folderId: baseParentId, folderKey: baseParentKey, displayName: file.name });
    }
    const pendingSet = new Set(plan.pendingFiles);
    const uploadTargets = [
      ...selection.files.map((record) => record.file),
      ...(selection.looseFiles || [])
    ].filter((file) => pendingSet.has(file));

    if (uploadTargets.length || plan.duplicateSkipped.length) {
      state.activeFolderUploadOperationId = null;
      state.uploading = false;
      submitButton.disabled = false;
      submitButton.textContent = "まとめて保存する";
      $("#folder-upload-password").value = "";
      syncAvailableActions();
      await uploadFiles(uploadTargets, destinations, {
        skipExisting: false,
        precheckedSkipped: plan.duplicateSkipped,
        newFolderCount: plan.newFolderCount,
        reusedFolderCount: plan.reusedFolderCount
      });
    } else {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = "フォルダ作成完了";
      $("#upload-file-progress").textContent = "保存完了";
      await Promise.all([loadItems(), loadUsage()]);
    }
  } catch (error) {
    if (state.activeFolderUploadOperationId === operationId) {
      panel.classList.add("upload-error");
      $("#upload-heading").textContent = "フォルダの準備に失敗しました";
      $("#upload-file-progress").textContent = "開始できませんでした";
      $("#upload-dismiss").hidden = false;
      setNotice(`フォルダの保存に失敗しました：${error.message}`, true);
    }
  } finally {
    if (state.activeFolderUploadOperationId === operationId) {
      state.activeFolderUploadOperationId = null;
      state.uploading = false;
      submitButton.disabled = false;
      submitButton.textContent = "まとめて保存する";
      syncAvailableActions();
      await syncTransferWakeLock();
    }
  }
}

function waitForInterfacePaint() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, 120);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function createEncryptedFolder(name, parentId, parentKey, password = "") {
  const encrypted = await TRoomCrypto.createFolderPackage(name, password, state.crypto.publicKey, parentKey);
  const result = await api("/folders", {
    method: "POST",
    body: JSON.stringify({ ...encrypted.payload, name: encrypted.name, parentId })
  });
  const created = { id: Number(result.id), key: encrypted.folderKey };
  state.crypto.folderKeys.set(created.id, created.key);
  await saveCachedFolderKey(created.id, created.key);
  return created;
}

async function loadUploadFolderChildren(parentId, operationCache) {
  const cacheKey = `children:${parentId || "root"}`;
  let children = operationCache.get(cacheKey);
  if (!children) {
    const params = new URLSearchParams({ sort: "name-asc", foldersOnly: "1" });
    if (parentId) params.set("folderId", parentId);
    const data = await api(`/items?${params}`);
    children = data.folders || [];
    operationCache.set(cacheKey, children);
  }
  return children;
}

async function resolveExistingUploadFolder(existing, parentKey) {
  const id = Number(existing.id);
  let key = state.crypto.folderKeys.get(id);
  if (!key && parentKey && existing.parentWrappedKey && existing.parentWrapIv) {
    try { key = await TRoomCrypto.unlockFolderFromParent(existing, parentKey); } catch {}
  }
  if (!key && state.session?.role === "admin" && state.crypto.adminPrivateKey) {
    try { key = await ensureAdminFolderKey(existing); } catch {}
  }
  if (!key) {
    throw new Error(`保存済みの「${existing.name}」フォルダはロックされています。先にフォルダを開いてPWを解除してから、もう一度アップロードしてください。`);
  }
  state.crypto.folderKeys.set(id, key);
  await saveCachedFolderKey(id, key);
  return { id, key, reused: true };
}

async function planFolderUpload(selection, baseParentId, baseParentKey, operationId) {
  const foldersByPath = new Map();
  const folderListingCache = new Map();
  let reusedFolderCount = 0;
  let newFolderCount = 0;

  for (let index = 0; index < selection.directories.length; index++) {
    if (state.activeFolderUploadOperationId !== operationId) throw new DOMException("中止しました", "AbortError");
    const path = selection.directories[index];
    const parts = path.split("/");
    const name = parts.at(-1);
    const parentPath = parts.slice(0, -1).join("/");
    const parentPlan = parentPath ? foldersByPath.get(parentPath) : { existing: true, id: baseParentId, key: baseParentKey };
    if (!parentPlan) throw new Error(`${path} の親フォルダを確認できませんでした。`);

    let folderPlan = { path, parentPath, name, existing: false, id: null, key: null };
    if (parentPlan.existing) {
      const children = await loadUploadFolderChildren(parentPlan.id, folderListingCache);
      const existing = children.find((folder) => normalizeUploadName(folder.name) === normalizeUploadName(name));
      if (existing) {
        const resolved = await resolveExistingUploadFolder(existing, parentPlan.key);
        folderPlan = { ...folderPlan, existing: true, id: resolved.id, key: resolved.key };
        reusedFolderCount++;
      } else {
        newFolderCount++;
      }
    } else {
      newFolderCount++;
    }
    foldersByPath.set(path, folderPlan);
    const completed = index + 1;
    $("#upload-status").textContent = `${completed} / ${selection.directories.length}フォルダ確認`;
    $("#upload-file-progress").textContent = `${Math.round(completed / selection.directories.length * 100)}%`;
  }

  const filesToCheck = [];
  const precheckDestinations = new Map();
  const pendingFiles = [];
  for (const record of selection.files) {
    if (Number(record.file.size) === 0) {
      pendingFiles.push(record.file);
      continue;
    }
    const folderPath = record.relativePath.split("/").slice(0, -1).join("/");
    const destination = foldersByPath.get(folderPath);
    if (!destination) throw new Error(`${record.relativePath} の保存先を確認できませんでした。`);
    filesToCheck.push(record.file);
    precheckDestinations.set(record.file, {
      folderId: destination.existing ? Number(destination.id) : null,
      displayName: record.relativePath
    });
  }
  for (const file of selection.looseFiles || []) {
    if (!baseParentId || !baseParentKey) throw new Error("単独ファイルの保存先フォルダを開いてから、もう一度ドロップしてください。");
    if (Number(file.size) === 0) {
      pendingFiles.push(file);
      continue;
    }
    filesToCheck.push(file);
    precheckDestinations.set(file, { folderId: Number(baseParentId), displayName: file.name });
  }

  const differential = filesToCheck.length
    ? await excludeExistingUploadFiles(filesToCheck, precheckDestinations)
    : { files: [], skipped: [] };
  pendingFiles.push(...differential.files);
  return {
    foldersByPath,
    reusedFolderCount,
    newFolderCount,
    pendingFiles,
    duplicateSkipped: differential.skipped
  };
}

function normalizeUploadName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("ja");
}

function uploadFileIdentity(name, size) {
  return [normalizeUploadName(name), Number(size || 0)].join("\u0000");
}

async function loadUploadConflictCandidates(sizes, folderId) {
  const candidates = [];
  const folders = new Map();
  const exactFolderId = Number(folderId);
  if (!Number.isSafeInteger(exactFolderId) || exactFolderId <= 0) return { candidates, folders };
  const uniqueSizes = [...new Set(sizes.map(Number).filter((size) => Number.isSafeInteger(size) && size > 0))];
  for (let start = 0; start < uniqueSizes.length; start += 50) {
    const batch = uniqueSizes.slice(start, start + 50);
    let offset = 0;
    do {
      const data = await api("/upload-conflict-candidates", {
        method: "POST",
        body: JSON.stringify({ sizes: batch, offset, folderId: exactFolderId })
      });
      for (const folder of data.folders || []) folders.set(Number(folder.id), { ...folder, id: Number(folder.id), parentId: Number(folder.parentId) || null });
      candidates.push(...(data.candidates || []));
      offset = Number.isInteger(data.nextOffset) ? data.nextOffset : -1;
    } while (offset >= 0);
  }
  return { candidates, folders };
}

async function unlockConflictFolderKeys(folders) {
  if (state.session?.role === "admin") {
    for (const folder of folders.values()) {
      try { await ensureAdminFolderKey(folder); } catch {}
    }
    return;
  }
  let changed = true;
  let guard = 0;
  while (changed && guard++ < folders.size + 1) {
    changed = false;
    for (const folder of folders.values()) {
      if (state.crypto.folderKeys.has(Number(folder.id))) continue;
      const parentKey = folder.parentId ? state.crypto.folderKeys.get(Number(folder.parentId)) : null;
      if (!parentKey || !folder.parentWrappedKey || !folder.parentWrapIv) continue;
      try {
        const key = await TRoomCrypto.unlockFolderFromParent(folder, parentKey);
        state.crypto.folderKeys.set(Number(folder.id), key);
        await saveCachedFolderKey(folder.id, key);
        changed = true;
      } catch {}
    }
  }
}

function conflictFolderPath(folderId, folders) {
  const names = [];
  let current = folders.get(Number(folderId));
  let guard = 0;
  while (current && guard++ < 100) {
    names.unshift(current.name || "名称なし");
    current = current.parentId ? folders.get(Number(current.parentId)) : null;
  }
  return ["T-Cloud Storage", ...names].join(" / ");
}

async function decryptExistingUploadConflicts(candidates, folders) {
  await unlockConflictFolderKeys(folders);
  const conflicts = new Map();
  for (const original of candidates) {
    try {
      let name = original.name;
      if (Number(original.cryptoVersion) === 1) {
        const folderKey = state.crypto.folderKeys.get(Number(original.folderId));
        if (!folderKey) continue;
        const fileKey = await TRoomCrypto.unlockFileKey(original, folderKey);
        const metadata = await TRoomCrypto.decryptFileMetadata(original, fileKey);
        name = metadata.name;
      }
      const identity = uploadFileIdentity(name, original.sizeBytes);
      const location = `${conflictFolderPath(original.folderId, folders)} / ${name}`;
      if (!conflicts.has(identity)) conflicts.set(identity, new Set());
      conflicts.get(identity).add(location);
    } catch {
      // 復号できない既存データは誤って保留せず、通常のアップロード対象に残す。
    }
  }
  return conflicts;
}

function incomingUploadRelativeFolder(file, destinations) {
  const displayName = normalizeRelativePath(destinations?.get(file)?.displayName || file.name);
  const segments = displayName.split("/");
  segments.pop();
  return segments.map(normalizeUploadName).join("/");
}

function incomingUploadIdentity(file, destinations) {
  return [incomingUploadRelativeFolder(file, destinations), uploadFileIdentity(file.name, file.size)].join("\u0000");
}

function findIncomingUploadConflictGroups(files, destinations = null) {
  const groups = new Map();
  for (const file of files) {
    const identity = incomingUploadIdentity(file, destinations);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(file);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function invalidateStoredConflicts() {
  state.conflictScanGeneration += 1;
  state.conflictScanRunning = false;
  state.conflictScanCompleted = false;
  state.conflictScanScheduled = false;
  state.conflictGroups = [];
  state.conflictFileGroups = new Map();
  state.conflictFolders = new Map();
  state.conflictTopFolders = [];
  syncVisibleConflictBadges();
}

function scheduleStoredConflictScan(force = false) {
  if (force) invalidateStoredConflicts();
  if (!state.session || state.view !== "all" || state.conflictScanRunning || state.conflictScanCompleted || state.conflictScanScheduled) return;
  if (!state.files.some((file) => Number(file.sizeBytes || 0) > 0)) return;
  if (state.session.role === "admin" && !state.crypto.adminPrivateKey) return;
  if (state.session.role === "subadmin" && state.crypto.folderKeys.size === 0) return;
  state.conflictScanScheduled = true;
  const run = () => {
    state.conflictScanScheduled = false;
    scanStoredConflicts().catch((error) => console.warn("Stored conflict scan was deferred.", error));
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2500 });
  else window.setTimeout(run, 350);
}

async function loadStoredConflictCandidates() {
  return loadUploadConflictCandidates(state.files.map((file) => Number(file.sizeBytes || 0)));
}

async function loadConflictOverviewCandidates() {
  const candidates = [];
  const folders = new Map();
  let offset = 0;
  do {
    const data = await api(`/conflicts?offset=${offset}`);
    candidates.push(...(data.candidates || []));
    for (const folder of data.folders || []) {
      folders.set(Number(folder.id), { ...folder, id: Number(folder.id), parentId: Number(folder.parentId) || null });
    }
    offset = Number.isInteger(data.nextOffset) ? data.nextOffset : -1;
  } while (offset >= 0);
  return { candidates, folders };
}

function conflictTimestampIdentity(file) {
  const originalTimestamp = Number(file.lastModified || 0);
  if (Number.isFinite(originalTimestamp) && originalTimestamp > 0) return `original:${Math.round(originalTimestamp)}`;
  const storedTimestamp = Date.parse(String(file.updatedAt || file.createdAt || "").replace(" ", "T") + "Z");
  return Number.isFinite(storedTimestamp) ? `stored:${Math.floor(storedTimestamp / 1000)}` : "";
}

function conflictSizesAreNear(left, right) {
  const a = Number(left || 0);
  const b = Number(right || 0);
  if (!a || !b) return false;
  const tolerance = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, Math.ceil(Math.max(a, b) * 0.005)));
  return Math.abs(a - b) <= tolerance;
}

function conflictPairReasons(left, right) {
  const sameName = normalizeUploadName(left.name) === normalizeUploadName(right.name);
  const exactSize = Number(left.sizeBytes || 0) === Number(right.sizeBytes || 0) && Number(left.sizeBytes || 0) > 0;
  const nearSize = conflictSizesAreNear(left.sizeBytes, right.sizeBytes);
  const leftTimestamp = conflictTimestampIdentity(left);
  const sameTimestamp = Boolean(leftTimestamp && leftTimestamp === conflictTimestampIdentity(right));
  if (!(nearSize && (sameName || sameTimestamp))) return [];
  const reasons = [];
  if (sameName) reasons.push("同じ名前");
  if (exactSize) reasons.push("同じ容量");
  else if (nearSize) reasons.push("容量が近い");
  if (sameTimestamp) reasons.push("更新日時が同じ");
  return reasons;
}

function buildConflictGroups(files, folders, options = {}) {
  const visibleIdentities = options.visibleIdentities || null;
  const groups = [];
  const byTopFolder = new Map();
  for (const file of files) {
    const topFolderId = Number(file.topFolderId || 0);
    if (!topFolderId) continue;
    if (!byTopFolder.has(topFolderId)) byTopFolder.set(topFolderId, []);
    byTopFolder.get(topFolderId).push(file);
  }

  for (const [topFolderId, scopedFiles] of byTopFolder) {
    const parent = new Map(scopedFiles.map((file) => [Number(file.id), Number(file.id)]));
    const rank = new Map(scopedFiles.map((file) => [Number(file.id), 0]));
    const pairReasons = new Map();
    const find = (id) => {
      let root = parent.get(id);
      while (root !== parent.get(root)) root = parent.get(root);
      let current = id;
      while (current !== root) {
        const next = parent.get(current);
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (leftId, rightId) => {
      let leftRoot = find(leftId);
      let rightRoot = find(rightId);
      if (leftRoot === rightRoot) return;
      if ((rank.get(leftRoot) || 0) < (rank.get(rightRoot) || 0)) [leftRoot, rightRoot] = [rightRoot, leftRoot];
      parent.set(rightRoot, leftRoot);
      if ((rank.get(leftRoot) || 0) === (rank.get(rightRoot) || 0)) rank.set(leftRoot, (rank.get(leftRoot) || 0) + 1);
    };
    const inspectNameIndex = (values) => {
      for (const originalFiles of values.values()) {
        const indexedFiles = [...originalFiles].sort((left, right) => Number(left.sizeBytes || 0) - Number(right.sizeBytes || 0));
        for (let leftIndex = 0; leftIndex < indexedFiles.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < indexedFiles.length; rightIndex += 1) {
            const left = indexedFiles[leftIndex];
            const right = indexedFiles[rightIndex];
            if (Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0) > 2 * 1024 * 1024) break;
            const pairKey = [Math.min(left.id, right.id), Math.max(left.id, right.id)].join(":");
            if (pairReasons.has(pairKey)) continue;
            const reasons = conflictPairReasons(left, right);
            if (!reasons.length) continue;
            pairReasons.set(pairKey, reasons);
            union(Number(left.id), Number(right.id));
          }
        }
      }
    };
    const inspectExactSizeTimestampIndex = (values) => {
      for (const indexedFiles of values.values()) {
        if (indexedFiles.length < 2) continue;
        const left = indexedFiles[0];
        for (let index = 1; index < indexedFiles.length; index += 1) {
          const right = indexedFiles[index];
          const pairKey = [Math.min(left.id, right.id), Math.max(left.id, right.id)].join(":");
          const reasons = conflictPairReasons(left, right);
          if (!reasons.length) continue;
          pairReasons.set(pairKey, reasons);
          union(Number(left.id), Number(right.id));
        }
      }
    };
    const nameIndex = new Map();
    const sizeTimestampIndex = new Map();
    for (const file of scopedFiles) {
      const timestampIdentity = conflictTimestampIdentity(file);
      const indexValues = [
        [nameIndex, normalizeUploadName(file.name)],
        [sizeTimestampIndex, timestampIdentity ? `${Number(file.sizeBytes || 0)}\u0000${timestampIdentity}` : ""]
      ];
      for (const [index, key] of indexValues) {
        if (!key || key === "0") continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(file);
      }
    }
    inspectNameIndex(nameIndex);
    inspectExactSizeTimestampIndex(sizeTimestampIndex);

    const components = new Map();
    for (const file of scopedFiles) {
      const root = find(Number(file.id));
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(file);
    }
    const componentReasons = new Map();
    for (const [pairKey, values] of pairReasons) {
      const [leftId] = pairKey.split(":").map(Number);
      const root = find(leftId);
      if (!componentReasons.has(root)) componentReasons.set(root, new Set());
      values.forEach((reason) => componentReasons.get(root).add(reason));
    }
    const topFolderName = folders.get(topFolderId)?.name || "フォルダ";
    for (const [root, component] of components) {
      if (component.length < 2) continue;
      if (visibleIdentities && !component.some((file) => visibleIdentities.has(uploadFileIdentity(file.name, file.sizeBytes)))) continue;
      const reasons = componentReasons.get(root) || new Set();
      const normalizedNames = new Set(component.map((file) => normalizeUploadName(file.name)));
      const displayName = normalizedNames.size === 1 ? component[0].name : "更新日時・容量が一致する候補";
      groups.push({
        id: `conflict-${topFolderId}-${component.map((file) => Number(file.id)).sort((a, b) => a - b).join("-")}`,
        name: displayName,
        topFolderId,
        topFolderName,
        sizeBytes: Number(component[0].sizeBytes || 0),
        reasons: [...reasons],
        files: component.sort((left, right) => left.name.localeCompare(right.name, "ja", { numeric: true, sensitivity: "base" }))
      });
    }
  }
  return groups.sort((left, right) => left.topFolderName.localeCompare(right.topFolderName, "ja", { numeric: true, sensitivity: "base" }) || left.name.localeCompare(right.name, "ja", { numeric: true, sensitivity: "base" }));
}

async function loadConflictOverview() {
  const generation = state.conflictScanGeneration;
  try {
    const { candidates, folders } = await loadConflictOverviewCandidates();
    if (generation !== state.conflictScanGeneration || state.view !== "conflicts") return;
    await unlockConflictFolderKeys(folders);
    const hydrated = await hydrateFileRecords(candidates, { preserveOrder: true });
    if (generation !== state.conflictScanGeneration || state.view !== "conflicts") return;
    for (const file of hydrated) {
      file.folderPath = conflictFolderPath(file.folderId, folders);
      file.folderName = folders.get(Number(file.folderId))?.name || "フォルダ";
    }
    state.conflictFolders = folders;
    state.conflictGroups = buildConflictGroups(hydrated.filter((file) => Number(file.cryptoVersion) !== 1 || file.fileKey), folders);
    state.conflictFileGroups = new Map(state.conflictGroups.flatMap((group) => group.files.map((file) => [Number(file.id), group.id])));
    state.conflictTopFolders = [...new Map(state.conflictGroups.map((group) => [group.topFolderId, { id: group.topFolderId, name: group.topFolderName }])).values()];
    state.conflictScanCompleted = true;
  } finally {
    if (generation === state.conflictScanGeneration) state.conflictScanRunning = false;
  }
}

function conflictReasonText(group) {
  return group.reasons?.length ? group.reasons.join("・") : "競合の疑いあり";
}

function conflictGroupButton(group) {
  const button = document.createElement("button");
  button.className = "conflict-group-button";
  button.type = "button";
  button.innerHTML = `<span><strong>${escapeHtml(group.name)}</strong><small>判定：${escapeHtml(conflictReasonText(group))}</small></span><span class="conflict-group-count">${group.files.length.toLocaleString("ja-JP")}件</span>`;
  button.addEventListener("click", () => openConflictGroup(group.id));
  return button;
}

const CONFLICT_CATEGORY_ORDER = ["audio", "video", "other"];

function conflictFileCategory(file) {
  const kind = detectClientKind(String(file?.mimeType || ""), String(file?.name || ""));
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  return "other";
}

function conflictGroupCategory(group) {
  const categories = new Set((group?.files || []).map(conflictFileCategory));
  return categories.size === 1 ? [...categories][0] : "other";
}

function conflictCategoryDetails(category) {
  return ({
    audio: { label: "音楽", symbol: "♪" },
    video: { label: "動画", symbol: "▶" },
    other: { label: "その他", symbol: "□" }
  })[category] || { label: "その他", symbol: "□" };
}

function conflictCategoryEntries(groups) {
  return CONFLICT_CATEGORY_ORDER.map((category) => ({
    category,
    details: conflictCategoryDetails(category),
    groups: groups.filter((group) => conflictGroupCategory(group) === category)
  })).filter((entry) => entry.groups.length);
}

function appendConflictCategoryList(container, groups, headingTag = "h3") {
  for (const entry of conflictCategoryEntries(groups)) {
    const heading = document.createElement(headingTag);
    heading.className = "conflict-category-heading";
    heading.innerHTML = `<span aria-hidden="true">${entry.details.symbol}</span><strong>${entry.details.label}</strong><small>${entry.groups.length.toLocaleString("ja-JP")}組</small>`;
    container.append(heading);
    entry.groups.forEach((group) => container.append(conflictGroupButton(group)));
  }
}

function renderConflictOverview(grid) {
  const guidance = document.createElement("p");
  guidance.className = "conflict-overview-guidance";
  guidance.innerHTML = '<span aria-hidden="true">⚠</span><span>競合ではないファイルが表示された場合は、T-Cloud管理者へお知らせください。</span>';
  grid.append(guidance);
  if (state.conflictScanRunning) {
    const loading = document.createElement("section");
    loading.className = "conflict-overview-loading";
    loading.innerHTML = "<strong>競合候補を確認しています</strong><span>トップフォルダごとに、配下のファイルを確認しています。</span>";
    grid.append(loading);
    return;
  }
  for (const topFolder of state.conflictTopFolders) {
    const groups = state.conflictGroups.filter((group) => Number(group.topFolderId) === Number(topFolder.id));
    const section = document.createElement("section");
    section.className = "conflict-overview-section";
    const heading = document.createElement("div");
    heading.className = "conflict-overview-heading";
    heading.innerHTML = `<span aria-hidden="true">⚠</span><div><h2>${escapeHtml(topFolder.name)}</h2><p>競合データ ${groups.length.toLocaleString("ja-JP")}組</p></div>`;
    const list = document.createElement("div");
    list.className = "conflict-overview-list";
    appendConflictCategoryList(list, groups);
    section.append(heading, list);
    grid.append(section);
  }
}

async function scanStoredConflicts() {
  if (state.conflictScanRunning || state.conflictScanCompleted) return;
  const generation = state.conflictScanGeneration;
  const visibleIdentities = new Set(state.files.map((file) => uploadFileIdentity(file.name, file.sizeBytes)));
  state.conflictScanRunning = true;
  try {
    const { candidates, folders } = await loadStoredConflictCandidates();
    if (generation !== state.conflictScanGeneration) return;
    await unlockConflictFolderKeys(folders);
    const hydrated = await hydrateFileRecords(candidates, { preserveOrder: true });
    if (generation !== state.conflictScanGeneration) return;
    const grouped = new Map();
    for (const file of hydrated) {
      if (Number(file.cryptoVersion) === 1 && !file.fileKey) continue;
      file.folderPath = conflictFolderPath(file.folderId, folders);
      file.folderName = folders.get(Number(file.folderId))?.name || "フォルダ";
      const identity = uploadFileIdentity(file.name, file.sizeBytes);
      if (!grouped.has(identity)) grouped.set(identity, []);
      grouped.get(identity).push(file);
    }
    const groups = [...grouped.values()]
      .filter((files) => files.length > 1 && visibleIdentities.has(uploadFileIdentity(files[0].name, files[0].sizeBytes)))
      .sort((left, right) => left[0].name.localeCompare(right[0].name, "ja", { numeric: true, sensitivity: "base" }))
      .map((files, index) => ({
        id: `conflict-${index + 1}`,
        name: files[0].name,
        sizeBytes: Number(files[0].sizeBytes || 0),
        files
      }));
    state.conflictGroups = groups;
    state.conflictFileGroups = new Map(groups.flatMap((group) => group.files.map((file) => [Number(file.id), group.id])));
    state.conflictFolders = folders;
    state.conflictScanCompleted = true;
    syncVisibleConflictBadges();
  } finally {
    if (generation === state.conflictScanGeneration) state.conflictScanRunning = false;
  }
}

function openConflictGroupList() {
  if (state.conflictScanRunning) return;
  if (!state.conflictGroups.length) {
    setNotice("競合候補は見つかりませんでした。");
    return;
  }
  renderConflictGroupList();
  const dialog = $("#conflict-dialog");
  if (!dialog.open) dialog.showModal();
}

function renderConflictGroupList() {
  $("#conflict-dialog-title").textContent = "競合グループ";
  $("#conflict-dialog-summary").textContent = "トップフォルダの境界を越えず、グループ単位で比較します。";
  $("#conflict-groups-back").hidden = true;
  $("#conflict-file-list").hidden = true;
  const list = $("#conflict-group-list");
  list.hidden = false;
  list.innerHTML = "";
  const topFolderIds = [...new Set(state.conflictGroups.map((group) => Number(group.topFolderId || 0)))];
  for (const topFolderId of topFolderIds) {
    const groups = state.conflictGroups.filter((group) => Number(group.topFolderId || 0) === topFolderId);
    if (groups[0]?.topFolderName) {
      const heading = document.createElement("h3");
      heading.className = "conflict-dialog-folder-heading";
      heading.textContent = groups[0].topFolderName;
      list.append(heading);
    }
    appendConflictCategoryList(list, groups, "h4");
  }
}

function openConflictGroup(groupId) {
  const group = state.conflictGroups.find((item) => item.id === groupId);
  if (!group) {
    setNotice("競合グループを再確認しています。", true);
    scheduleStoredConflictScan(true);
    return;
  }
  $("#conflict-dialog-title").textContent = group.name;
  $("#conflict-dialog-summary").textContent = `${group.topFolderName ? `${group.topFolderName}・` : ""}${conflictReasonText(group)}・${group.files.length.toLocaleString("ja-JP")}件の候補です。`;
  $("#conflict-groups-back").hidden = false;
  $("#conflict-group-list").hidden = true;
  const list = $("#conflict-file-list");
  list.hidden = false;
  list.innerHTML = "";
  for (const file of group.files) list.append(conflictFileRow(file));
  const dialog = $("#conflict-dialog");
  if (!dialog.open) dialog.showModal();
}

function canTrashConflictFile(file) {
  if (state.session?.canDelete) return true;
  return Boolean(state.session?.canTrashUnlockedFiles
    && file?.fileKey
    && state.crypto.folderKeys.has(Number(file.folderId)));
}

function conflictFileRow(file) {
  const row = document.createElement("article");
  row.className = "conflict-file-row";
  const copy = document.createElement("div");
  copy.className = "conflict-file-copy";
  copy.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.folderPath)}</span><small>${formatBytes(file.sizeBytes)}・更新 ${formatDate(file.updatedAt || file.createdAt)}</small>`;
  const actions = document.createElement("div");
  actions.className = "conflict-file-actions";
  const openButton = document.createElement("button");
  openButton.className = "secondary-button";
  openButton.type = "button";
  openButton.textContent = "場所を開く";
  openButton.addEventListener("click", () => openConflictFileLocation(file));
  actions.append(openButton);
  if (canRenameFile(file)) {
    const renameButton = document.createElement("button");
    renameButton.className = "secondary-button";
    renameButton.type = "button";
    renameButton.textContent = "名前変更";
    renameButton.addEventListener("click", () => editConflictFile(file));
    actions.append(renameButton);
  }
  if (canTrashConflictFile(file)) {
    const deleteButton = document.createElement("button");
    deleteButton.className = "danger-button";
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => deleteConflictFile(file));
    actions.append(deleteButton);
  }
  row.append(copy, actions);
  return row;
}

async function openConflictFileLocation(file) {
  $("#conflict-dialog").close();
  await navigateToFolder(Number(file.folderId), file.folderName || "ファイル");
  requestAnimationFrame(() => {
    const card = $(`.file-card[data-file-id="${Number(file.id)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("conflict-focus");
    window.setTimeout(() => card?.classList.remove("conflict-focus"), 1800);
  });
}

function editConflictFile(file) {
  $("#conflict-dialog").close();
  state.selected = file;
  openEditDialog();
}

async function deleteConflictFile(file) {
  if (!canTrashConflictFile(file)) return;
  const message = state.session?.canDelete ? `「${file.name}」をゴミ箱へ移動しますか？` : "本当に削除しますか？";
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  try {
    await api(`/files/${file.id}`, { method: "DELETE", body: "{}" });
    $("#conflict-dialog").close();
    invalidateStoredConflicts();
    setNotice(state.session?.canDelete ? "ゴミ箱へ移動しました。競合を再確認します。" : "削除しました。競合を再確認します。");
    const reloads = [loadItems()];
    if (state.session?.role === "admin") reloads.push(loadUsage());
    await Promise.all(reloads);
  } catch (error) { setNotice(error.message, true); }
}

async function excludeExistingUploadFiles(files, destinations) {
  const skipped = [];
  const skippedSet = new Set();
  for (const group of findIncomingUploadConflictGroups(files, destinations)) {
    for (const file of group) {
      skippedSet.add(file);
      skipped.push({
        file,
        displayName: destinations?.get(file)?.displayName || file.name,
        reason: "今回選択したデータ内に同名・同容量のファイルがあります。",
        duplicateCount: group.length,
        kind: "selection"
      });
    }
  }

  const remaining = files.filter((file) => !skippedSet.has(file));
  if (remaining.length) {
    $("#upload-activity").textContent = "保存済みデータの競合候補を確認中";
    const filesByDestination = new Map();
    for (const file of remaining) {
      const folderId = Number(destinations?.get(file)?.folderId ?? state.folderId);
      if (!Number.isSafeInteger(folderId) || folderId <= 0) continue;
      if (!filesByDestination.has(folderId)) filesByDestination.set(folderId, []);
      filesByDestination.get(folderId).push(file);
    }
    for (const [folderId, destinationFiles] of filesByDestination) {
      const { candidates, folders } = await loadUploadConflictCandidates(destinationFiles.map((file) => file.size), folderId);
      const existingConflicts = await decryptExistingUploadConflicts(candidates, folders);
      for (const file of destinationFiles) {
        const locations = [...(existingConflicts.get(uploadFileIdentity(file.name, file.size)) || [])];
        if (!locations.length) continue;
        skippedSet.add(file);
        skipped.push({
          file,
          displayName: destinations?.get(file)?.displayName || file.name,
          reason: "同じ保存先に、同名・同容量の保存済みデータがあります。",
          existingLocations: locations,
          kind: "existing"
        });
      }
    }
  }
  return { files: files.filter((file) => !skippedSet.has(file)), skipped };
}

function showUploadPlanSummary(newFolderCount, uploadFileCount, reusedFolderCount, skippedFileCount, zeroByteCount = 0) {
  const added = `${Number(newFolderCount || 0)}フォルダ・${Number(uploadFileCount || 0)}ファイルを追加`;
  const existing = `${Number(reusedFolderCount || 0)}フォルダを再利用・${Number(skippedFileCount || 0)}ファイルを競合候補として保留`;
  const excluded = Number(zeroByteCount || 0) ? `・${Number(zeroByteCount)}件は空ファイル` : "";
  const summary = $("#upload-plan-summary");
  summary.textContent = `差分確認：${added}／${existing}${excluded}`;
  summary.hidden = false;
}

async function uploadFiles(files, destinations = null, options = {}) {
  const precheckedSkipped = Array.isArray(options.precheckedSkipped) ? options.precheckedSkipped : [];
  if ((!files.length && !precheckedSkipped.length) || !state.session.canUpload) return;
  if (state.uploading) {
    setNotice("アップロードが完了してから、次のファイルを追加してください。", true);
    return;
  }
  if (!state.crypto.fileEncryptionReady) {
    setNotice("暗号化の初期設定を完了してください。", true);
    return;
  }
  const requestedTotal = files.length;
  const safetyConfirmed = options.safetyConfirmed === true;
  const skippedFiles = files
    .filter((file) => Number(file.size) === 0)
    .map((file) => ({
      file,
      displayName: destinations?.get(file)?.displayName || file.name,
      error: new Error("空ファイル（0バイト）のため、アップロード対象外です。")
    }));
  files = files.filter((file) => Number(file.size) > 0);
  $("#file-input").value = "";
  state.uploading = true;
  state.uploadAbort = new AbortController();
  syncAvailableActions();
  const panel = $("#upload-panel");
  const fixedFolderId = state.folderId ? Number(state.folderId) : null;
  const fixedFolderKey = fixedFolderId ? state.crypto.folderKeys.get(fixedFolderId) : null;
  let duplicateSkipped = [...precheckedSkipped];
  let tracker = { stop() {} };
  let completed = 0;
  let cancelled = false;
  panel.hidden = false;
  panel.classList.remove("upload-complete", "upload-error");
  $("#upload-plan-summary").hidden = true;
  $("#upload-heading").textContent = options.skipExisting === false ? "アップロード中" : "アップロード内容を確認中";
  $("#upload-status").textContent = `0 / ${files.length}件完了`;
  $("#upload-progress").style.width = "0%";
  $("#upload-speed").textContent = "";
  $("#upload-bytes").textContent = `0 B / ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`;
  $("#upload-eta").textContent = "残り時間：計算中";
  $("#upload-activity").textContent = "送信準備中";
  $("#upload-activity").classList.remove("waiting");
  renderTransferFailures("#upload-failure-summary", "#upload-failed-list", []);
  renderUploadConflicts(precheckedSkipped);
  state.pendingSafetyUpload = null;
  $("#upload-safety-actions").hidden = true;
  $("#upload-dismiss").hidden = true;
  $("#upload-cancel").hidden = false;
  $("#upload-cancel").disabled = false;
  await syncTransferWakeLock();
  try {
    if (options.skipExisting !== false && files.length) {
      $("#upload-heading").textContent = "競合候補を確認中";
      $("#upload-file-progress").textContent = "差分を確認しています";
      const differential = await excludeExistingUploadFiles(files, destinations);
      files = differential.files;
      duplicateSkipped = [...precheckedSkipped, ...differential.skipped];
      renderUploadConflicts(duplicateSkipped);
    }
    const total = files.length;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const connectionLimit = getUploadConnectionLimit();
    const fileLimit = Math.min(getUploadFileLimit(), total);
    const partLimiter = createUploadLimiter(connectionLimit);
    tracker = createUploadTracker(files, totalBytes);
    $("#upload-heading").textContent = total ? "アップロード中" : "差分確認完了";
    $("#upload-status").textContent = `0 / ${total}件完了`;
    showUploadPlanSummary(options.newFolderCount, total, options.reusedFolderCount, duplicateSkipped.length, skippedFiles.length);
    $("#upload-bytes").textContent = `0 B / ${formatBytes(totalBytes)}`;
    $("#upload-activity").textContent = total ? "送信準備中" : "競合候補は保留しました";
    let nextFileIndex = 0;
    const deferred = [];
    const fileWorker = async () => {
      while (true) {
        if (state.uploadAbort.signal.aborted) {
          return;
        }
        const index = nextFileIndex++;
        if (index >= files.length) return;
        const file = files[index];
        const destination = destinations?.get(file);
        const destinationFolderId = destination?.folderId ?? fixedFolderId;
        const destinationFolderKey = destination?.folderKey ?? fixedFolderKey;
        try {
          await uploadOne(file, index + 1, total, destinationFolderId, destinationFolderKey, state.uploadAbort.signal, partLimiter, tracker, safetyConfirmed);
          completed++;
          tracker.finish(file, completed);
        } catch (error) {
          if (error.name === "AbortError") return;
          tracker.defer(file);
          deferred.push({
            error,
            file,
            index,
            destinationFolderId,
            destinationFolderKey,
            displayName: destination?.displayName || file.name
          });
        }
      }
    };
    await Promise.allSettled(Array.from({ length: fileLimit }, fileWorker));
    if (state.uploadAbort.signal.aborted) {
      cancelled = true;
      $("#upload-heading").textContent = "アップロードを停止しました";
      $("#upload-status").textContent = `${completed} / ${total}件完了`;
      $("#upload-file-progress").textContent = "未完了分は保存されていません";
      setNotice(`アップロードを停止しました。完了済みの${completed}件は保存されています。`);
    }
    let finalFailures = [];
    if (!cancelled && deferred.length) {
      $("#upload-heading").textContent = "エラー分を再試行中";
      for (const item of deferred.sort((a, b) => a.index - b.index)) {
        if (state.uploadAbort.signal.aborted) {
          cancelled = true;
          break;
        }
        const { file, index, destinationFolderId, destinationFolderKey } = item;
        if (isSafetyConfirmationError(item.error)) {
          finalFailures.push({ file, error: item.error, destinationFolderId, destinationFolderKey, displayName: item.displayName });
          continue;
        }
        try {
          await uploadOne(file, index + 1, total, destinationFolderId, destinationFolderKey, state.uploadAbort.signal, partLimiter, tracker, safetyConfirmed);
          completed++;
          tracker.finish(file, completed);
        } catch (error) {
          if (error.name === "AbortError") {
            cancelled = true;
            break;
          }
          tracker.defer(file);
          finalFailures.push({ file, error, destinationFolderId, destinationFolderKey, displayName: item.displayName });
        }
      }
    }
    if (cancelled) {
      $("#upload-heading").textContent = "アップロードを停止しました";
      $("#upload-status").textContent = `${completed} / ${total}件完了`;
      $("#upload-file-progress").textContent = "未完了分は保存されていません";
      setNotice(`アップロードを停止しました。完了済みの${completed}件は保存されています。`);
    } else if (finalFailures.length) {
      const unavailable = [...finalFailures, ...skippedFiles];
      const safetyFailures = finalFailures.filter((item) => isSafetyConfirmationError(item.error));
      if (safetyFailures.length) {
        const retryDestinations = new Map();
        for (const item of safetyFailures) retryDestinations.set(item.file, {
          folderId: item.destinationFolderId,
          folderKey: item.destinationFolderKey,
          displayName: item.displayName
        });
        state.pendingSafetyUpload = { files: safetyFailures.map((item) => item.file), destinations: retryDestinations };
        $("#upload-safety-actions").hidden = false;
      }
      panel.classList.add("upload-error");
      $("#upload-heading").textContent = safetyFailures.length ? "アップロードの確認が必要です" : "一部のアップロードに失敗しました";
      $("#upload-status").textContent = duplicateSkipped.length
        ? `${completed}件保存・${duplicateSkipped.length}件を競合候補として保留`
        : `${completed} / ${requestedTotal}件保存`;
      $("#upload-file-progress").textContent = `${unavailable.length}件を保存できませんでした`;
      renderTransferFailures("#upload-failure-summary", "#upload-failed-list", unavailable);
      setNotice(`${completed}件を保存しました。保存できなかったデータを一覧に表示しています。`, true);
    } else if (skippedFiles.length) {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = completed ? "アップロード完了（対象外あり）" : "アップロード対象を確認してください";
      $("#upload-status").textContent = duplicateSkipped.length
        ? `${completed}件保存・${duplicateSkipped.length}件を競合候補として保留`
        : `${completed} / ${requestedTotal}件保存`;
      $("#upload-file-progress").textContent = `${skippedFiles.length}件は対象外`;
      renderTransferFailures("#upload-failure-summary", "#upload-failed-list", skippedFiles);
      setNotice(completed
        ? `${completed}件を保存しました。空ファイルは理由とともに一覧へ表示しています。`
        : "空ファイルは保存せず、理由を一覧へ表示しています。", true);
    } else if (duplicateSkipped.length) {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = "差分アップロード完了";
      $("#upload-status").textContent = `${completed}件保存・${duplicateSkipped.length}件を競合候補として保留`;
      $("#upload-file-progress").textContent = completed ? "競合しないデータだけ保存しました" : "競合候補のため保存を保留しました";
      $("#upload-dismiss").hidden = false;
      setNotice(completed
        ? `${completed}件を追加し、競合候補の${duplicateSkipped.length}件は保留しました。`
        : `競合候補の${duplicateSkipped.length}件は保存せず保留しました。`);
    } else {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = "アップロード完了";
      $("#upload-file-progress").textContent = "Cloudflareへの保存確認済み";
      await new Promise((resolve) => setTimeout(resolve, 900));
      panel.hidden = true;
    }
  } catch (error) {
    panel.classList.add("upload-error");
    $("#upload-heading").textContent = options.skipExisting === false ? "アップロードを開始できませんでした" : "差分確認に失敗しました";
    $("#upload-status").textContent = "データは追加していません";
    $("#upload-file-progress").textContent = error.message;
    $("#upload-dismiss").hidden = false;
    setNotice(error.message, true);
  } finally {
    tracker.stop();
    state.uploading = false;
    state.uploadAbort = null;
    $("#upload-cancel").hidden = true;
    $("#upload-cancel").disabled = false;
    $("#upload-dismiss").hidden = $("#upload-failure-summary").hidden && !duplicateSkipped.length && !skippedFiles.length && !panel.classList.contains("upload-error");
    syncAvailableActions();
    await syncTransferWakeLock();
  }
  if (completed) invalidateStoredConflicts();
  await Promise.all([loadItems(), loadUsage()]);
}

async function uploadOne(file, index, total, destinationFolderId, destinationFolderKey, signal, partLimiter, tracker, safetyConfirmed = false) {
  throwIfUploadCancelled(signal);
  tracker.start(file, index, total);
  tracker.phase(file, "安全性確認中…");
  if (!safetyConfirmed && isBlockedClientFile(file)) throw safetyConfirmationError("安全上、このファイル形式は保存できません。");
  if (!globalThis.TCloudSafety) throw new Error("安全性確認機能を読み込めません。ページを再読み込みしてください。");
  if (!safetyConfirmed) await TCloudSafety.inspect(file);
  throwIfUploadCancelled(signal);
  const folderId = Number(destinationFolderId);
  const folderKey = destinationFolderKey || state.crypto.folderKeys.get(folderId);
  if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
  const mediaKind = detectClientKind(file.type || "application/octet-stream", file.name);
  const thumbnailPromise = makeThumbnail(file);
  const durationPromise = readLocalMediaDuration(file, mediaKind);
  tracker.phase(file, "暗号化準備中…");
  const encrypted = await TRoomCrypto.createFilePackage(file, folderKey, mediaKind);
  throwIfUploadCancelled(signal);
  let init = null;
  let uploadCompleted = false;
  try {
    tracker.phase(file, "Cloudflareへ送信準備中…");
    init = await api("/uploads", {
      method: "POST",
      body: JSON.stringify({ ...encrypted.payload, folderId }),
      signal
    });
    const chunkCount = Math.ceil(file.size / init.chunkSize);
    const parts = new Array(chunkCount);
    let nextPartNumber = 1;
    const uploadWorker = async () => {
      while (true) {
        throwIfUploadCancelled(signal);
        const partNumber = nextPartNumber++;
        if (partNumber > chunkCount) return;
        const offset = (partNumber - 1) * init.chunkSize;
        const end = Math.min(offset + init.chunkSize, file.size);
        parts[partNumber - 1] = await partLimiter(async () => {
          throwIfUploadCancelled(signal);
          const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          const encryptedChunk = await TRoomCrypto.encryptFileChunk(encrypted.fileKey, chunk, partNumber - 1);
          chunk.fill(0);
          throwIfUploadCancelled(signal);
          const plainBytes = end - offset;
          return uploadPartWithRetry(`/uploads/${init.id}/parts/${partNumber}`, encryptedChunk, signal, {
            onProgress: (loaded, transmittedTotal, attempt) => {
              const ratio = transmittedTotal > 0 ? Math.min(1, loaded / transmittedTotal) : 0;
              tracker.partProgress(file, partNumber, attempt, Math.round(plainBytes * ratio), plainBytes);
            },
            onRetry: (nextAttempt, maxAttempts) => tracker.retry(file, partNumber, nextAttempt, maxAttempts)
          });
        });
        tracker.partProgress(file, partNumber, 0, end - offset, end - offset, true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(connectionLimitForFile(partLimiter.limit, total), chunkCount) }, uploadWorker));
    throwIfUploadCancelled(signal);
    tracker.phase(file, "Cloudflareで保存を確定中…");
    const confirmation = await api(`/uploads/${init.id}/complete`, { method: "POST", body: JSON.stringify({ parts }), signal });
    if (!confirmation?.verified) throw new Error("Cloudflare上の保存確認を完了できませんでした。");
    uploadCompleted = true;
    tracker.phase(file, "Cloudflareへの保存確認済み");
    if (signal?.aborted) return;
    try {
      const durationSeconds = normalizeDurationSeconds(await durationPromise);
      if (durationSeconds) {
        const metadata = await TRoomCrypto.encryptFileMetadata(fileMetadataForStorage(file, mediaKind, durationSeconds), encrypted.fileKey);
        await api(`/files/${init.id}`, { method: "PATCH", body: JSON.stringify(metadata), signal });
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      console.warn("Media duration metadata could not be saved", error);
    }
    tracker.phase(file, "サムネイル処理中…");
    try {
      const thumbnail = await thumbnailPromise;
      if (thumbnail && !signal?.aborted) {
        const encryptedThumbnail = await TRoomCrypto.encryptThumbnail(thumbnail, encrypted.fileKey);
        if (!signal?.aborted) await api(`/files/${init.id}/thumbnail`, { method: "PUT", body: encryptedThumbnail, rawBody: true, signal });
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      console.warn("Thumbnail upload failed after the file was saved", error);
    }
    tracker.phase(file, "完了");
  } catch (error) {
    if (error.name === "AbortError" && uploadCompleted) return;
    if (init?.id && !uploadCompleted) {
      try { await api(`/uploads/${init.id}`, { method: "DELETE", body: "{}" }); } catch {}
    }
    throw error;
  }
}

function getUploadConnectionLimit() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const mobile = matchMedia("(max-width: 760px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType)) return 1;
  if (connection?.effectiveType === "3g") return 2;
  const cpu = Number(navigator.hardwareConcurrency) || 4;
  const memory = Number(navigator.deviceMemory) || 4;
  if (mobile) return cpu >= 6 && memory >= 4 ? 3 : 2;
  if (cpu >= 8 && memory >= 8) return 6;
  if (cpu >= 4 && memory >= 4) return 4;
  return 2;
}

function getUploadFileLimit() {
  const mobile = matchMedia("(max-width: 760px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return mobile ? 1 : 2;
}

function connectionLimitForFile(limit, totalFiles) {
  return totalFiles > 1 ? Math.max(1, Math.ceil(limit / 2)) : limit;
}

function createUploadLimiter(limit) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active--;
      runNext();
    });
  };
  const limiter = (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
  limiter.limit = limit;
  return limiter;
}

function createUploadTracker(files, totalBytes) {
  const startedAt = performance.now();
  const active = new Map();
  const partsByFile = new Map(files.map((file) => [file, new Map()]));
  const networkAttemptsByFile = new Map(files.map((file) => [file, new Map()]));
  const completedFiles = new Set();
  const samples = [];
  let networkBytes = 0;
  let lastActivityAt = 0;
  let phaseStartedAt = startedAt;
  let currentPhase = "送信準備中";
  let stopped = false;
  const uploadedFor = (file) => {
    if (completedFiles.has(file)) return Number(file.size || 0);
    return [...(partsByFile.get(file)?.values() || [])].reduce((sum, part) => sum + Math.min(Number(part.size || 0), Number(part.loaded || 0)), 0);
  };
  const refresh = () => {
    if (stopped) return;
    const now = performance.now();
    const uploadedBytes = files.reduce((sum, file) => sum + uploadedFor(file), 0);
    const percent = totalBytes ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 100;
    while (samples.length > 2 && samples[0].time < now - 8000) samples.shift();
    const firstSample = samples[0];
    const lastSample = samples.at(-1);
    const sampleSeconds = firstSample && lastSample ? Math.max(.25, (lastSample.time - firstSample.time) / 1000) : 0;
    const bytesPerSecond = sampleSeconds > 0 ? Math.max(0, (lastSample.bytes - firstSample.bytes) / sampleSeconds) : 0;
    const remainingSeconds = bytesPerSecond > 0 ? Math.max(0, totalBytes - uploadedBytes) / bytesPerSecond : 0;
    $("#upload-progress").style.width = `${percent}%`;
    $("#upload-file-progress").textContent = `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
    $("#upload-speed").textContent = bytesPerSecond > 0 ? formatTransferRate(bytesPerSecond) : "速度計測中";
    $("#upload-bytes").textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`;
    $("#upload-eta").textContent = bytesPerSecond > 0 && uploadedBytes < totalBytes ? `残り約${formatTransferDuration(remainingSeconds)}` : (uploadedBytes >= totalBytes ? "送信完了" : "残り時間：計算中");
    const secondsSinceActivity = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : 0;
    const communicating = currentPhase === "Cloudflareへ送信中";
    const waiting = communicating && lastActivityAt && secondsSinceActivity >= 15;
    const phaseElapsed = Math.max(0, Math.floor((now - phaseStartedAt) / 1000));
    const activity = waiting
      ? `通信応答待ち・最終通信${secondsSinceActivity}秒前`
      : communicating
      ? (lastActivityAt ? `通信中・最終通信${secondsSinceActivity}秒前` : "通信開始待ち")
      : phaseElapsed >= 2 ? `${currentPhase}（${phaseElapsed}秒経過）` : currentPhase;
    $("#upload-activity").textContent = activity;
    $("#upload-activity").classList.toggle("waiting", Boolean(waiting || currentPhase.startsWith("通信再試行中")));
    const names = [...active.keys()].map((file) => file.name);
    $("#upload-file-name").textContent = names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : (names[0] || "");
  };
  const timer = setInterval(refresh, 1000);
  return {
    start(file) { active.set(file, true); refresh(); },
    partProgress(file, partNumber, attempt, loaded, size, completed = false) {
      const parts = partsByFile.get(file);
      if (!parts) return;
      const attemptKey = `${partNumber}:${attempt}`;
      const attempts = networkAttemptsByFile.get(file);
      if (!(completed && attempt === 0)) {
        const previousNetworkLoaded = Number(attempts.get(attemptKey) || 0);
        const currentNetworkLoaded = Math.max(previousNetworkLoaded, Number(loaded || 0));
        attempts.set(attemptKey, currentNetworkLoaded);
        networkBytes += Math.max(0, currentNetworkLoaded - previousNetworkLoaded);
      }
      if (completed) parts.set(partNumber, { attempt, loaded: size, size, completed: true });
      else if (!parts.get(partNumber)?.completed) parts.set(partNumber, { attempt, loaded, size, completed: false });
      lastActivityAt = performance.now();
      currentPhase = "Cloudflareへ送信中";
      phaseStartedAt = lastActivityAt;
      samples.push({ time: lastActivityAt, bytes: networkBytes });
      refresh();
    },
    retry(file, partNumber, nextAttempt, maxAttempts) {
      const parts = partsByFile.get(file);
      const current = parts?.get(partNumber);
      if (parts && !current?.completed) parts.set(partNumber, { attempt: nextAttempt, loaded: 0, size: Number(current?.size || 0), completed: false });
      currentPhase = `通信再試行中 ${nextAttempt}/${maxAttempts}回`;
      phaseStartedAt = performance.now();
      refresh();
    },
    phase(file, label) {
      if (!active.has(file)) return;
      currentPhase = label.replace(/…$/, "");
      phaseStartedAt = performance.now();
      refresh();
    },
    finish(file, completed) {
      completedFiles.add(file);
      active.delete(file);
      $("#upload-status").textContent = `${completed} / ${files.length}件完了`;
      refresh();
    },
    defer(file) {
      partsByFile.set(file, new Map());
      completedFiles.delete(file);
      active.delete(file);
      refresh();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function uploadPartWithRetry(path, body, signal, callbacks = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await uploadPartRequest(path, body, signal, (loaded, total) => callbacks.onProgress?.(loaded, total, attempt));
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === maxAttempts) throw error;
      callbacks.onRetry?.(attempt + 1, maxAttempts);
      await uploadRetryDelay(400 * (2 ** (attempt - 1)) + Math.random() * 250, signal);
    }
  }
}

function uploadPartRequest(path, body, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("中止しました", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    request.open("PUT", `${API}${path}`, true);
    request.withCredentials = true;
    request.responseType = "json";
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => onProgress?.(Number(event.loaded || 0), Number(event.total || body.byteLength || 0));
    request.onload = () => {
      cleanup();
      const data = request.response && typeof request.response === "object" ? request.response : null;
      if (request.status >= 200 && request.status < 300) {
        resolve(data);
        return;
      }
      if (request.status === 401 && state.session) location.reload();
      const error = new Error(data?.error || `通信に失敗しました（${request.status}）`);
      error.status = request.status;
      reject(error);
    };
    request.onerror = () => { cleanup(); reject(new Error("通信が切断されました。")); };
    request.onabort = () => { cleanup(); reject(new DOMException("中止しました", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    request.send(body);
  });
}

function formatTransferRate(bytesPerSecond) {
  const mbps = (Number(bytesPerSecond || 0) * 8) / 1_000_000;
  return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} Mbps（${formatBytes(bytesPerSecond)}/秒）`;
}

function formatTransferDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (value < 60) return `${Math.max(1, value)}秒`;
  if (value < 3600) return `${Math.ceil(value / 60)}分`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.ceil((value % 3600) / 60);
  return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
}

function uploadRetryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("アップロードを停止しました", "AbortError"));
    }, { once: true });
  });
}

function cancelUploads() {
  if (!state.uploadAbort || state.uploadAbort.signal.aborted) return;
  $("#upload-cancel").disabled = true;
  $("#upload-file-progress").textContent = "停止処理中…";
  state.uploadAbort.abort();
}

function dismissUploadMessage() {
  if (state.uploading) return;
  state.pendingSafetyUpload = null;
  $("#upload-safety-actions").hidden = true;
  const panel = $("#upload-panel");
  renderTransferFailures("#upload-failure-summary", "#upload-failed-list", []);
  renderUploadConflicts([]);
  panel.classList.remove("upload-complete", "upload-error");
  panel.hidden = true;
  $("#upload-plan-summary").hidden = true;
  $("#upload-dismiss").hidden = true;
  setNotice("");
}

function cancelPendingSafetyUpload() {
  if (state.uploading) return;
  const count = state.pendingSafetyUpload?.files?.length || 0;
  state.pendingSafetyUpload = null;
  $("#upload-safety-actions").hidden = true;
  $("#upload-heading").textContent = "確認対象のアップロードをキャンセルしました";
  $("#upload-file-progress").textContent = `${count}件は保存されていません`;
  setNotice("確認対象のデータは保存していません。");
}

async function continuePendingSafetyUpload() {
  if (state.uploading || !state.pendingSafetyUpload?.files?.length) return;
  const pending = state.pendingSafetyUpload;
  state.pendingSafetyUpload = null;
  $("#upload-safety-actions").hidden = true;
  await uploadFiles(pending.files, pending.destinations, { safetyConfirmed: true, skipExisting: false });
}

function safetyConfirmationError(message) {
  const error = new Error(message);
  error.code = "SAFETY_CONFIRM_REQUIRED";
  error.requiresConfirmation = true;
  return error;
}

function isSafetyConfirmationError(error) {
  return error?.code === "SAFETY_CONFIRM_REQUIRED" || error?.requiresConfirmation === true;
}

function throwIfUploadCancelled(signal) {
  if (signal?.aborted) throw new DOMException("アップロードを停止しました", "AbortError");
}

async function makeThumbnail(file) {
  const kind = detectClientKind(file.type || "application/octet-stream", file.name);
  if (kind === "video") return makeVideoThumbnail(file);
  if (kind !== "image") return null;
  try {
    const image = await createImageBitmap(file);
    const max = 640;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .78));
  } catch { return null; }
}

async function readLocalMediaDuration(file, mediaKind) {
  if (!["video", "audio"].includes(mediaKind)) return null;
  const url = URL.createObjectURL(file);
  const media = document.createElement(mediaKind === "audio" ? "audio" : "video");
  media.preload = "metadata";
  media.muted = true;
  const mpegType = mediaKind === "video" ? mpegContainerType(file.name) : "";
  let player = null;
  try {
    if (mpegType && globalThis.mpegts?.isSupported()) {
      player = mpegts.createPlayer({ type: mpegType, isLive: false, url, filesize: Number(file.size || 0) || undefined }, { enableWorker: false, lazyLoad: true, lazyLoadMaxDuration: 30, seekType: "range" });
      player.attachMediaElement(media);
      player.load();
    } else {
      media.src = url;
      media.load();
    }
    await waitForVideoEvent(media, "loadedmetadata", 20000);
    return normalizeDurationSeconds(media.duration);
  } catch {
    return null;
  } finally {
    try { player?.unload(); } catch {}
    try { player?.detachMediaElement(); } catch {}
    try { player?.destroy(); } catch {}
    media.removeAttribute("src");
    try { media.load(); } catch {}
    URL.revokeObjectURL(url);
  }
}

async function makeVideoThumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    return await captureVideoThumbnail(url, file);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function captureVideoThumbnail(url, file = {}) {
  const mpegType = mpegContainerType(file.name);
  if (mpegType && globalThis.mpegts?.isSupported()) return captureMpegVideoThumbnail(url, file, mpegType);
  return captureNativeVideoThumbnail(url);
}

async function captureNativeVideoThumbnail(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    video.load();
    await waitForVideoEvent(video, "loadedmetadata");
    if (Number.isFinite(video.duration) && video.duration > 0.2) {
      const seeked = waitForVideoEvent(video, "seeked");
      video.currentTime = Math.min(1, video.duration * 0.1);
      await seeked;
    } else if (video.readyState < 2) {
      await waitForVideoEvent(video, "loadeddata");
    }
    return videoFrameToThumbnail(video);
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function captureMpegVideoThumbnail(url, file, type) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const player = mpegts.createPlayer({ type, isLive: false, url, filesize: Number(file.size || file.sizeBytes || 0) || undefined }, {
    enableWorker: false,
    lazyLoad: true,
    lazyLoadMaxDuration: 30,
    seekType: "range"
  });
  try {
    player.attachMediaElement(video);
    player.load();
    await waitForVideoEvent(video, "loadeddata", 20000);
    if (Number.isFinite(video.duration) && video.duration > 0.5) {
      try {
        const seeked = waitForVideoEvent(video, "seeked", 8000);
        video.currentTime = Math.min(1, video.duration * 0.1);
        await seeked;
      } catch {
        // 最初に復号できた映像フレームを使用する。
      }
    }
    return await videoFrameToThumbnail(video);
  } catch {
    return null;
  } finally {
    try { player.unload(); } catch {}
    try { player.detachMediaElement(); } catch {}
    try { player.destroy(); } catch {}
    video.removeAttribute("src");
    video.load();
  }
}

function waitForVideoEvent(video, eventName, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, done);
      video.removeEventListener("error", failed);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("動画を読み込めませんでした。")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("動画の読み込みがタイムアウトしました。")); }, timeout);
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

async function videoFrameToThumbnail(video) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
  const max = 640;
  const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .78));
}

function mpegContainerType(name) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  if (extension === "flv") return "flv";
  if (["ts", "m2ts", "mts"].includes(extension)) return "m2ts";
  return "";
}

function scheduleMissingMediaDurations() {
  state.durationScanGeneration += 1;
  const generation = state.durationScanGeneration;
  state.durationObserver?.disconnect();
  state.durationObserver = null;
  state.durationQueue = state.durationQueue.filter((entry) => entry.generation === generation);
  if (state.view !== "all" || state.uploading || state.downloadActive) return;
  const eligible = state.files.filter((file) => {
    if (!["video", "audio"].includes(file.mediaKind) || file.durationSeconds || !file.fileKey || !canRenameFile(file)) return false;
    if (state.session?.role === "admin" && file.mediaKind === "video" && !file.hasThumbnail && !state.thumbnailAttempts.has(Number(file.id))) return false;
    return (state.durationAttempts.get(Number(file.id)) || 0) < 2;
  });
  if (!eligible.length) return;
  const enqueueCard = (card) => {
    const file = eligible.find((item) => Number(item.id) === Number(card.dataset.fileId));
    if (file) enqueueDurationBackfill(file, generation);
  };
  if (!globalThis.IntersectionObserver) {
    eligible.slice(0, 8).forEach((file) => enqueueDurationBackfill(file, generation));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueueCard(entry.target);
    }
  }, { rootMargin: "240px 0px" });
  state.durationObserver = observer;
  for (const file of eligible) {
    const card = $(`.file-card[data-file-id="${Number(file.id)}"]`);
    if (card) observer.observe(card);
  }
}

function enqueueDurationBackfill(file, generation, retryDelay = 0) {
  if (generation !== state.durationScanGeneration || file.durationSeconds) return;
  const queued = state.durationQueue.some((entry) => Number(entry.file.id) === Number(file.id) && entry.generation === generation);
  if (queued || state.durationUpdates.has(Number(file.id))) return;
  const enqueue = () => {
    if (generation !== state.durationScanGeneration || file.durationSeconds) return;
    file.durationPending = true;
    updateDurationDisplay(file);
    state.durationQueue.push({ file, generation });
    void processDurationBackfillQueue();
  };
  if (retryDelay) window.setTimeout(enqueue, retryDelay);
  else enqueue();
}

async function processDurationBackfillQueue() {
  if (state.durationBackfillRunning) return;
  state.durationBackfillRunning = true;
  try {
    while (state.durationQueue.length) {
      const { file, generation } = state.durationQueue.shift();
      if (generation !== state.durationScanGeneration || file.durationSeconds) continue;
      const fileId = Number(file.id);
      const attempts = (state.durationAttempts.get(fileId) || 0) + 1;
      state.durationAttempts.set(fileId, attempts);
      const duration = await readStoredMediaDuration(file);
      if (generation !== state.durationScanGeneration) continue;
      file.durationPending = false;
      if (duration) {
        file.durationUnavailable = false;
        await persistMediaDuration(file, duration);
      } else if (attempts < 2) {
        enqueueDurationBackfill(file, generation, 1200);
      } else {
        file.durationUnavailable = true;
        updateDurationDisplay(file);
      }
    }
  } finally {
    state.durationBackfillRunning = false;
    if (state.durationQueue.length) void processDurationBackfillQueue();
  }
}

async function registerMediaWithDeviceCache(file, endpoint) {
  attachOfflineStorageIdentity(file);
  return TCloudMedia.registerMedia(file, file.fileKey, endpoint);
}

async function prepareDeviceCacheEntry(file) {
  const context = currentOfflineContext();
  attachOfflineStorageIdentity(file, context);
  if (!file?.offlineStorageId || !context || !globalThis.TCloudOffline?.supported()) return;
  await TCloudOffline.beginEntry({
    id: file.offlineStorageId,
    accountScope: context.accountScope,
    rootFolderId: context.rootFolderId,
    fileId: Number(file.id),
    version: String(file.updatedAt || file.createdAt || "1"),
    chunkCount: Number(file.chunkCount || Math.ceil(Number(file.sizeBytes || 0) / Number(file.chunkSizeBytes || 8 * 1024 * 1024))),
    chunkSizeBytes: Number(file.chunkSizeBytes || 8 * 1024 * 1024),
    encryptedSizeBytes: Number(file.encryptedSizeBytes || file.sizeBytes || 0),
    offline: false,
    complete: false
  }).catch(() => {});
}

async function readStoredMediaDuration(file) {
  let mediaToken = "";
  try {
    const media = await TCloudMedia.registerMedia(file, file.fileKey, `${API}/files/${file.id}/view`);
    mediaToken = media.token;
    return await readMediaDurationFromUrl(media.url, file);
  } catch {
    return null;
  } finally {
    if (mediaToken) TCloudMedia.releaseMedia(mediaToken);
  }
}

async function readMediaDurationFromUrl(url, file) {
  const media = document.createElement(file.mediaKind === "audio" ? "audio" : "video");
  media.preload = "metadata";
  media.muted = true;
  const mpegType = file.mediaKind === "video" ? mpegContainerType(file.name) : "";
  let player = null;
  try {
    if (mpegType && globalThis.mpegts?.isSupported()) {
      player = mpegts.createPlayer({ type: mpegType, isLive: false, url, filesize: Number(file.sizeBytes || 0) || undefined }, { enableWorker: false, lazyLoad: true, lazyLoadMaxDuration: 30, seekType: "range" });
      player.attachMediaElement(media);
      player.load();
    } else {
      media.src = url;
      media.load();
    }
    await waitForVideoEvent(media, "loadedmetadata", 20000);
    return normalizeDurationSeconds(media.duration);
  } catch {
    return null;
  } finally {
    try { player?.unload(); } catch {}
    try { player?.detachMediaElement(); } catch {}
    try { player?.destroy(); } catch {}
    media.removeAttribute("src");
    try { media.load(); } catch {}
  }
}

function scheduleMissingVideoThumbnails() {
  if (state.session?.role !== "admin" || state.view !== "all" || state.thumbnailBackfillRunning) return;
  void backfillMissingVideoThumbnails();
}

async function backfillMissingVideoThumbnails() {
  state.thumbnailBackfillRunning = true;
  try {
    for (const file of state.files) {
      if (file.mediaKind !== "video" || file.hasThumbnail || !file.fileKey || state.thumbnailAttempts.has(Number(file.id))) continue;
      state.thumbnailAttempts.add(Number(file.id));
      await backfillVideoThumbnail(file);
    }
  } finally {
    state.thumbnailBackfillRunning = false;
  }
}

async function backfillVideoThumbnail(file) {
  let mediaToken = "";
  try {
    const media = await TCloudMedia.registerMedia(file, file.fileKey, `${API}/files/${file.id}/view`);
    mediaToken = media.token;
    const [thumbnailResult, durationResult] = await Promise.allSettled([
      captureVideoThumbnail(media.url, file),
      file.durationSeconds ? Promise.resolve(file.durationSeconds) : readMediaDurationFromUrl(media.url, file)
    ]);
    const duration = durationResult.status === "fulfilled" ? normalizeDurationSeconds(durationResult.value) : null;
    if (duration) await persistMediaDuration(file, duration);
    const thumbnail = thumbnailResult.status === "fulfilled" ? thumbnailResult.value : null;
    if (thumbnail) {
      const encryptedThumbnail = await TRoomCrypto.encryptThumbnail(thumbnail, file.fileKey);
      await api(`/files/${file.id}/thumbnail`, { method: "PUT", body: encryptedThumbnail, rawBody: true });
      file.hasThumbnail = true;
      showGeneratedThumbnail(file, thumbnail);
    }
  } catch {
    // 再生できない形式では、明確な動画アイコンを残す。
  } finally {
    if (mediaToken) TCloudMedia.releaseMedia(mediaToken);
  }
}

function showGeneratedThumbnail(file, thumbnail) {
  const stage = document.querySelector(`.file-card[data-file-id="${Number(file.id)}"] .thumb`);
  if (!stage) return;
  const url = URL.createObjectURL(thumbnail);
  const image = new Image();
  image.alt = "";
  image.loading = "lazy";
  image.onload = () => URL.revokeObjectURL(url);
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
  stage.replaceChildren(image);
}

async function createFolder(event) {
  event.preventDefault();
  try {
    if (!state.crypto.publicKey) throw new Error("暗号化の初期設定を完了してください。");
    const parentKey = state.folderId ? state.crypto.folderKeys.get(Number(state.folderId)) : null;
    if (state.folderId && !parentKey) throw new Error("親フォルダの暗号化鍵を解除してください。");
    const password = $("#folder-password-enabled").checked ? $("#folder-password").value : "";
    const encrypted = await TRoomCrypto.createFolderPackage($("#folder-name").value, password, state.crypto.publicKey, parentKey);
    const result = await api("/folders", { method: "POST", body: JSON.stringify({ ...encrypted.payload, name: encrypted.name, parentId: state.folderId }) });
    state.crypto.folderKeys.set(result.id, encrypted.folderKey);
    await saveCachedFolderKey(result.id, encrypted.folderKey);
    $("#folder-name").value = "";
    $("#folder-password-enabled").checked = false;
    $("#folder-password").value = "";
    toggleNewFolderPasswordInput();
    $("#folder-dialog").close();
    await loadItems();
  } catch (error) { setNotice(error.message, true); }
}

async function unlockFolder(event) {
  event.preventDefault();
  const id = Number($("#unlock-folder-id").value);
  $("#unlock-error").textContent = "";
  try {
    const folder = findFolderRecord(id);
    if (!folder) throw new Error("フォルダ情報を読み込めませんでした。");
    const unlocked = await TRoomCrypto.unlockFolderWithPassword(folder, $("#unlock-password").value);
    await api(`/folders/${id}/unlock`, { method: "POST", body: JSON.stringify({ authProof: unlocked.authProof }) });
    state.crypto.folderKeys.set(id, unlocked.folderKey);
    await saveCachedFolderKey(id, unlocked.folderKey);
    folder.isUnlocked = true;
    $("#unlock-dialog").close();
    invalidateStoredConflicts();
    await navigateToFolder(id, folder.name);
  } catch (error) {
    $("#unlock-error").textContent = error.message;
  }
}

async function openPreview(file, options = {}) {
  const { pushHistory = true } = options;
  const dialog = $("#preview-dialog");
  const generation = ++state.previewGeneration;
  if (pushHistory && !dialog.open && state.historyReady) {
    history.pushState({
      tcloud: true,
      folderId: state.folderId,
      folderName: $("#view-title").textContent,
      previewId: file.id
    }, "", location.href);
    state.previewHistoryActive = true;
  } else if (!pushHistory && state.previewHistoryActive && state.historyReady) {
    history.replaceState({
      tcloud: true,
      folderId: state.folderId,
      folderName: $("#view-title").textContent,
      previewId: file.id
    }, "", location.href);
  }
  clearPreviewUrl();
  state.previewFileId = Number(file.id);
  state.selected = file;
  $("#preview-more").open = false;
  $("#preview-title").textContent = file.name;
  $("#preview-kind").textContent = kindLabel(file.mediaKind);
  $("#preview-size").textContent = formatMediaDetails(file);
  $("#preview-date").textContent = formatDate(file.createdAt);
  $("#download-link").href = Number(file.cryptoVersion) === 1 ? "#" : `${API}/files/${file.id}/download`;
  $("#edit-file-button").hidden = Boolean(file.offlineOnly) || !canRenameFile(file);
  $("#delete-file-button").hidden = Boolean(file.offlineOnly) || !canTrashFile(file);
  $("#delete-file-button").textContent = state.session.canDelete ? "ゴミ箱へ" : "削除";
  const stage = $("#preview-stage");
  stage.classList.remove("has-custom-video-controls", "is-media-ready");
  stage.innerHTML = "";
  syncPreviewNavigation(file);
  let url = `${API}/files/${file.id}/view`;
  let preparedVideo = null;
  if (Number(file.cryptoVersion) === 1) {
    if (!file.fileKey) {
      stage.innerHTML = `<div class="preview-fallback"><p>暗号化鍵を解除できないため表示できません。</p></div>`;
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (file.mediaKind === "video") {
      preparedVideo = prepareVideoPlayer(stage, file);
      preparedVideo.buffering.textContent = "暗号を復号して再生準備をしています…";
    } else {
      stage.innerHTML = `<div class="preview-loading"><p>暗号を復号して再生準備をしています…</p></div>`;
    }
    if (!dialog.open) dialog.showModal();
    try {
      const streaming = file.mediaKind === "video" || file.mediaKind === "audio" || Number(file.sizeBytes) > 128 * 1024 * 1024;
      if (streaming) {
        const media = await registerMediaWithDeviceCache(file, `${API}/files/${file.id}/view`);
        if (!previewRequestActive(generation, file.id)) {
          TCloudMedia.releaseMedia(media.token);
          return;
        }
        state.previewMediaToken = media.token;
        url = media.url;
      } else {
        await prepareDeviceCacheEntry(file);
        const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/view`);
        const objectUrl = URL.createObjectURL(blob);
        if (!previewRequestActive(generation, file.id)) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        state.previewUrl = objectUrl;
        url = state.previewUrl;
      }
    } catch (error) {
      if (!previewRequestActive(generation, file.id)) return;
      if (preparedVideo) showVideoPlayerError(stage, preparedVideo.buffering, error.message);
      else stage.innerHTML = `<div class="preview-fallback"><p>${escapeHtml(error.message)}</p></div>`;
      return;
    }
  }
  if (!previewRequestActive(generation, file.id)) return;
  if (file.mediaKind === "image") {
    renderPreviewImage(stage, file, url, generation);
  } else if (file.mediaKind === "video") {
    loadVideoPlayerSource(preparedVideo || prepareVideoPlayer(stage, file), file, url, generation);
  } else if (file.mediaKind === "audio") {
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; observeAndPersistMediaDuration(audio, file); audio.src = url; stage.replaceChildren(audio);
  } else if (file.mimeType === "application/pdf") {
    const frame = document.createElement("iframe"); frame.title = file.name; frame.src = url; stage.replaceChildren(frame);
  } else {
    stage.innerHTML = `<div class="preview-fallback"><p>この形式はブラウザ内プレビューに対応していません。</p><p>ダウンロードしてご確認ください。</p></div>`;
  }
  if (!dialog.open) dialog.showModal();
}

function renderPreviewImage(stage, file, url, generation) {
  const image = new Image();
  image.alt = file.name;
  image.addEventListener("load", () => {
    if (previewRequestActive(generation, file.id) && $("#preview-dialog").open) stage.replaceChildren(image);
  }, { once: true });
  image.addEventListener("error", () => {
    if (previewRequestActive(generation, file.id) && $("#preview-dialog").open) {
      stage.innerHTML = '<div class="preview-fallback"><p>写真を表示できませんでした。</p><p>ダウンロードしてご確認ください。</p></div>';
    }
  }, { once: true });
  image.src = url;
}

function previewImages() {
  return state.files.filter((file) => !file.trashed && file.mediaKind === "image");
}

function syncPreviewNavigation(file) {
  const images = previewImages();
  const index = images.findIndex((item) => Number(item.id) === Number(file.id));
  const show = file.mediaKind === "image" && index >= 0 && images.length > 1;
  $("#preview-prev").hidden = !show;
  $("#preview-next").hidden = !show;
  $("#preview-counter").hidden = file.mediaKind !== "image" || index < 0;
  $("#preview-counter").textContent = index >= 0 ? `${index + 1} / ${images.length}` : "";
  $("#preview-prev").disabled = index <= 0;
  $("#preview-next").disabled = index < 0 || index >= images.length - 1;
}

async function navigatePreview(direction) {
  if (!$("#preview-dialog").open) return;
  const images = previewImages();
  const index = images.findIndex((file) => Number(file.id) === Number(state.previewFileId));
  const next = images[index + direction];
  if (!next) return;
  await openPreview(next, { pushHistory: false });
}

function handlePreviewKeydown(event) {
  if (!$("#preview-dialog").open) return;
  if (event.target.closest?.("input, textarea, select, button, a")) return;
  const video = $("#preview-stage video");
  if (video && event.code === "Space") {
    event.preventDefault();
    video.paused ? video.play().catch(() => {}) : video.pause();
  } else if (video && event.key === "ArrowLeft") {
    event.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 10);
  } else if (video && event.key === "ArrowRight") {
    event.preventDefault();
    video.currentTime = Math.min(Number.isFinite(video.duration) ? video.duration : video.currentTime + 10, video.currentTime + 10);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigatePreview(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    navigatePreview(1);
  }
}

function isInstalledAppMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function previewVideoIsFullscreen(sourceVideo = null) {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  const container = $("#preview-stage-wrap");
  const fullscreenVideo = fullscreenElement?.matches?.("video")
    ? fullscreenElement
    : fullscreenElement?.querySelector?.("video");
  return Boolean($("#preview-dialog").open && (
    (fullscreenVideo && container?.contains(fullscreenVideo))
    || (sourceVideo && sourceVideo.webkitDisplayingFullscreen)
  ));
}

function recordOrientationLockFailure(mode, error, reason) {
  state.previewOrientationLastError = {
    mode,
    reason,
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "画面方向を固定できませんでした"),
    occurredAt: new Date().toISOString()
  };
  console.warn(`T-Cloud orientation lock failed (${mode}/${reason})`, error);
}

function waitForOrientationFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function waitForOrientationSettle() {
  await waitForOrientationFrame();
  await waitForOrientationFrame();
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function restoreInstalledAppPortrait({ settle = false, reason = "folder" } = {}) {
  state.previewVideoFullscreenActive = false;
  const requestGeneration = ++state.previewOrientationGeneration;
  if (!isInstalledAppMode() || !screen.orientation?.lock) return false;
  if (settle) await waitForOrientationSettle();
  const retryDelays = [0, 120, 360];
  for (const delay of retryDelays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (requestGeneration !== state.previewOrientationGeneration || state.previewVideoFullscreenActive || previewVideoIsFullscreen()) return false;
    try {
      await screen.orientation.lock("portrait-primary");
      state.previewOrientationLastError = null;
      return true;
    } catch (error) {
      recordOrientationLockFailure("portrait-primary", error, reason);
    }
  }
  return false;
}

async function prepareInstalledVideoFullscreen(sourceVideo = null) {
  const requestGeneration = ++state.previewOrientationGeneration;
  if (!isInstalledAppMode() || !screen.orientation?.lock || !previewVideoIsFullscreen(sourceVideo)) return;
  state.previewVideoFullscreenActive = true;
  try {
    await screen.orientation.lock("any");
    if (requestGeneration !== state.previewOrientationGeneration || !state.previewVideoFullscreenActive || !previewVideoIsFullscreen(sourceVideo)) {
      await restoreInstalledAppPortrait();
    }
  } catch (error) {
    recordOrientationLockFailure("any", error, "video-fullscreen");
  }
}

function enforceFolderPortraitOrientation() {
  if (document.visibilityState === "hidden" || state.previewVideoFullscreenActive || previewVideoIsFullscreen()) return;
  restoreInstalledAppPortrait();
}

function handlePreviewFullscreenOrientationChange() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  syncPreviewSeekbarFullscreenControl(fullscreenElement);
  const fullscreenVideo = fullscreenElement?.matches?.("video")
    ? fullscreenElement
    : fullscreenElement?.querySelector?.("video");
  state.previewVideoFullscreenActive = Boolean(fullscreenVideo && previewVideoIsFullscreen(fullscreenVideo));
  if (state.previewVideoFullscreenActive) prepareInstalledVideoFullscreen(fullscreenVideo);
  else restoreInstalledAppPortrait({ settle: true, reason: "fullscreen-exit" });
}

async function togglePreviewPlayerFullscreen(event) {
  event.preventDefault();
  event.stopPropagation();
  const container = $("#preview-stage-wrap");
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

function syncPreviewSeekbarFullscreenControl(fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement) {
  const button = $("#preview-stage .preview-player-fullscreen");
  if (!button) return;
  const active = Boolean(fullscreenElement && $("#preview-stage-wrap").contains(fullscreenElement))
    || fullscreenElement === $("#preview-stage-wrap");
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

function addPreviewPlayerControls(stage, video) {
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
  let playbackFrame = 0;
  let lastPaused = null;
  let lastTimeText = "";
  let lastSeekValue = "";
  const syncPlayback = () => {
    playbackFrame = 0;
    if (!controls.isConnected && stage.isConnected) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (lastPaused !== video.paused) {
      lastPaused = video.paused;
      playButton.innerHTML = previewControlIcon(video.paused ? "play" : "pause");
      playButton.setAttribute("aria-label", video.paused ? "再生" : "一時停止");
    }
    const timeText = `${formatPreviewPlaybackTime(current)} / ${formatPreviewPlaybackTime(duration)}`;
    if (lastTimeText !== timeText) {
      lastTimeText = timeText;
      timeLabel.textContent = timeText;
      seek.setAttribute("aria-valuetext", timeText);
    }
    seek.disabled = !duration;
    const seekValue = duration ? String(Math.min(1000, Math.round(current / duration * 1000))) : "0";
    if (lastSeekValue !== seekValue) {
      lastSeekValue = seekValue;
      seek.value = seekValue;
    }
  };
  const queuePlaybackSync = () => {
    if (!playbackFrame) playbackFrame = requestAnimationFrame(syncPlayback);
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
  fullscreenButton.addEventListener("click", togglePreviewPlayerFullscreen);
  for (const eventName of ["click", "dblclick", "pointerdown", "touchstart", "touchend"]) {
    controls.addEventListener(eventName, (event) => event.stopPropagation());
  }
  for (const eventName of ["loadedmetadata", "durationchange", "timeupdate"]) video.addEventListener(eventName, queuePlaybackSync);
  for (const eventName of ["play", "pause", "ended"]) video.addEventListener(eventName, syncPlayback);
  video.addEventListener("volumechange", syncVolume);
  stage.append(controls);
  syncPlayback();
  syncVolume();
  syncPreviewSeekbarFullscreenControl();
}

function handlePreviewDoubleClick(event) {
  const video = $("#preview-stage video");
  if (!video) return;
  const bounds = $("#preview-stage").getBoundingClientRect();
  const forward = event.clientX >= bounds.left + bounds.width / 2;
  const nextTime = Math.max(0, video.currentTime + (forward ? 10 : -10));
  video.currentTime = Number.isFinite(video.duration) ? Math.min(video.duration, nextTime) : nextTime;
}

function handlePreviewTouchStart(event) {
  const touch = event.changedTouches?.[0];
  state.previewTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function handlePreviewTouchEnd(event) {
  const start = state.previewTouchStart;
  const touch = event.changedTouches?.[0];
  state.previewTouchStart = null;
  if (!start || !touch) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
  navigatePreview(dx < 0 ? 1 : -1);
}

function handlePreviewClosed() {
  state.previewGeneration += 1;
  clearPreviewUrl();
  restoreInstalledAppPortrait({ settle: true, reason: "preview-close" });
  state.previewFileId = null;
  state.previewTouchStart = null;
  if (state.previewHistoryActive && !state.handlingPopState) {
    state.previewHistoryActive = false;
    history.back();
  }
}

function clearPreviewUrl() {
  const stage = $("#preview-stage");
  stopPreviewMediaElements(stage);
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
  stage?.classList.remove("has-custom-video-controls", "is-media-ready");
  stage?.replaceChildren();
}

function stopPreviewMediaElements(stage) {
  if (!stage) return;
  for (const media of stage.querySelectorAll("video, audio")) {
    try { media.pause(); } catch {}
    try { media.srcObject = null; } catch {}
    media.removeAttribute("src");
    try { media.load(); } catch {}
  }
  for (const frame of stage.querySelectorAll("iframe")) frame.src = "about:blank";
}

function previewRequestActive(generation, fileId) {
  return generation === state.previewGeneration && Number(state.previewFileId) === Number(fileId);
}

function prepareVideoPlayer(stage, file) {
  const video = document.createElement("video");
  video.controls = false;
  video.playsInline = true;
  video.preload = "metadata";
  video.disableRemotePlayback = true;
  video.setAttribute("disableRemotePlayback", "");
  video.setAttribute("controlsList", "noremoteplayback");
  video.setAttribute("x-webkit-airplay", "deny");
  video.addEventListener("webkitbeginfullscreen", () => prepareInstalledVideoFullscreen(video));
  video.addEventListener("webkitendfullscreen", () => restoreInstalledAppPortrait({ settle: true, reason: "webkit-fullscreen-exit" }));
  const buffering = document.createElement("div");
  buffering.className = "player-buffering";
  buffering.textContent = "再生準備中…";
  stage.replaceChildren(video, buffering);
  addPreviewPlayerControls(stage, video);
  observeAndPersistMediaDuration(video, file);
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    stage.classList.add("is-media-ready");
    buffering.classList.add("is-hidden");
    setTimeout(() => buffering.remove(), 180);
  };
  video.addEventListener("loadeddata", reveal, { once: true });
  video.addEventListener("canplay", reveal, { once: true });
  return { stage, video, buffering };
}

function showVideoPlayerError(stage, buffering, text) {
  stage.classList.remove("is-media-ready");
  buffering.classList.remove("is-hidden");
  buffering.textContent = text;
  buffering.classList.add("player-error");
}

function loadVideoPlayerSource(prepared, file, url, generation) {
  const { stage, video, buffering } = prepared;
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  const mpegType = extension === "flv" ? "flv" : ["ts", "m2ts", "mts"].includes(extension) ? "m2ts" : "";
  if (mpegType && globalThis.mpegts?.isSupported()) {
    const player = mpegts.createPlayer({ type: mpegType, isLive: false, url, filesize: Number(file.sizeBytes) }, {
      enableWorker: false,
      lazyLoad: true,
      lazyLoadMaxDuration: 180,
      seekType: "range"
    });
    player.on(mpegts.Events.ERROR, () => {
      if (!previewRequestActive(generation, file.id) || !$("#preview-dialog").open) return;
      if (stage.querySelector(".player-error")) return;
      showVideoPlayerError(stage, buffering, "このFLV・MPEG-TS動画の映像または音声方式には対応していません。元の画質のままダウンロードしてご確認ください。");
      try { player.unload(); } catch {}
    });
    player.attachMediaElement(video);
    state.previewPlayer = player;
    player.load();
    return;
  }
  video.src = url;
  video.addEventListener("error", () => {
    if (!previewRequestActive(generation, file.id) || !$("#preview-dialog").open) return;
    if (!video.error) return;
    showVideoPlayerError(stage, buffering, "この動画の映像・音声方式はブラウザで再生できません。元の画質のままダウンロードしてご確認ください。");
  }, { once: true });
}

function renderVideoPlayer(stage, file, url, generation) {
  loadVideoPlayerSource(prepareVideoPlayer(stage, file), file, url, generation);
}

function observeAndPersistMediaDuration(media, file) {
  const update = () => {
    const durationSeconds = normalizeDurationSeconds(media.duration);
    if (durationSeconds) void persistMediaDuration(file, durationSeconds);
  };
  media.addEventListener("loadedmetadata", update, { once: true });
  media.addEventListener("durationchange", update);
}

async function persistMediaDuration(file, durationSeconds) {
  const normalized = normalizeDurationSeconds(durationSeconds);
  if (!normalized || normalized === normalizeDurationSeconds(file.durationSeconds)) return;
  file.durationSeconds = normalized;
  file.durationPending = false;
  file.durationUnavailable = false;
  updateDurationDisplay(file);
  if (Number(file.cryptoVersion) !== 1 || !file.fileKey || !canRenameFile(file) || state.durationUpdates.has(Number(file.id))) return;
  state.durationUpdates.add(Number(file.id));
  try {
    const encryptedMetadata = await TRoomCrypto.encryptFileMetadata(fileMetadataForStorage(file, file.mediaKind, normalized), file.fileKey);
    await api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify(encryptedMetadata) });
    file.encryptedMetadata = encryptedMetadata.encryptedMetadata;
    file.metadataIv = encryptedMetadata.metadataIv;
  } catch (error) {
    console.warn("Media duration metadata could not be updated", error);
  } finally {
    state.durationUpdates.delete(Number(file.id));
  }
}

function updateDurationDisplay(file) {
  const card = $(`.file-card[data-file-id="${Number(file.id)}"]`);
  const size = card?.querySelector(".file-size");
  if (size) size.textContent = formatMediaDetails(file);
  if (Number(state.previewFileId) === Number(file.id)) $("#preview-size").textContent = formatMediaDetails(file);
}

function fileMetadataForStorage(file, mediaKind, durationSeconds = null, name = file.name) {
  const metadata = {
    name,
    mimeType: file.type || file.mimeType || "application/octet-stream",
    mediaKind,
    lastModified: Number(file.lastModified || 0)
  };
  const normalized = normalizeDurationSeconds(durationSeconds);
  if (normalized) metadata.durationSeconds = normalized;
  return metadata;
}

function openEditDialog() {
  const file = state.selected;
  if (!file) return;
  if (!canRenameFile(file)) {
    setNotice("PWで解除したフォルダ内のファイル名だけ変更できます。", true);
    return;
  }
  $("#edit-file-id").value = file.id;
  $("#edit-name").value = file.name;
  $("#edit-error").textContent = "";
  closePreviewForAction();
  $("#edit-dialog").showModal();
}

function closePreviewForAction() {
  state.previewHistoryActive = false;
  if (state.historyReady) {
    history.replaceState({
      tcloud: true,
      folderId: state.folderId,
      folderName: $("#view-title").textContent,
      previewId: null
    }, "", location.href);
  }
  if ($("#preview-dialog").open) $("#preview-dialog").close();
}

async function saveFile(event) {
  event.preventDefault();
  const id = Number($("#edit-file-id").value);
  $("#edit-error").textContent = "";
  try {
    const file = state.selected;
    if (!file || Number(file.id) !== id) throw new Error("変更するファイルをもう一度開いてください。");
    if (!canRenameFile(file)) throw new Error("PWで解除したフォルダ内のファイル名だけ変更できます。");
    const name = cleanEditableName($("#edit-name").value);
    if (Number(file.cryptoVersion) === 1) {
      if (!file.fileKey) throw new Error("ファイルの暗号化鍵を解除してください。");
      const metadata = fileMetadataForStorage(file, file.mediaKind, file.durationSeconds, name);
      const encryptedMetadata = await TRoomCrypto.encryptFileMetadata(metadata, file.fileKey);
      await api(`/files/${id}`, { method: "PATCH", body: JSON.stringify(encryptedMetadata) });
      file.name = metadata.name;
      file.encryptedMetadata = encryptedMetadata.encryptedMetadata;
      file.metadataIv = encryptedMetadata.metadataIv;
    } else {
      await api(`/files/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    }
    $("#edit-dialog").close();
    setNotice("ファイル情報を更新しました。");
    invalidateStoredConflicts();
    await loadItems();
  } catch (error) { $("#edit-error").textContent = error.message; }
}

async function deleteSelectedFile() {
  const file = state.selected;
  if (!file || !canTrashFile(file)) return;
  const message = state.session?.canDelete ? `「${file.name}」をゴミ箱へ移動しますか？` : "本当に削除しますか？";
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  try {
    await api(`/files/${file.id}`, { method: "DELETE", body: "{}" });
    await removeDeviceCopiesForFiles([file]);
    $("#preview-dialog").close();
    setNotice(state.session?.canDelete ? "ゴミ箱へ移動しました。" : "削除しました。");
    invalidateStoredConflicts();
    const reloads = [loadItems()];
    if (state.session?.role === "admin") reloads.push(loadUsage());
    await Promise.all(reloads);
  } catch (error) { setNotice(error.message, true); }
}

function confirmSubadminDeletion(message = "本当に削除しますか？") {
  const dialog = $("#delete-confirm-dialog");
  $("#delete-confirm-copy").textContent = message;
  dialog.returnValue = "no";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
    dialog.showModal();
  });
}

async function approveDeletionRequest(item) {
  if (!state.session.canReviewDeletion || item.unavailable) return;
  if (!confirm(`「${item.name}」の削除を承認し、ゴミ箱へ移動しますか？`)) return;
  try {
    await api(`/deletion-requests/${item.id}/approve`, { method: "POST", body: "{}" });
    setNotice("削除を承認し、ファイルをゴミ箱へ移動しました。");
    await Promise.all([loadItems(), loadUsage(), loadDeletionRequestCount()]);
  } catch (error) { setNotice(error.message, true); }
}

async function showTrashActions(file) {
  state.selected = { ...file, trashTargetType: "file" };
  $("#trash-file-name").textContent = file.name;
  $("#trash-action-note").textContent = "元に戻すか、完全に削除する操作を選んでください。";
  $("#permanent-delete-button").hidden = !state.session.canDelete;
  $("#trash-dialog").showModal();
}

async function showTrashFolderActions(folder) {
  state.selected = { ...folder, trashTargetType: "folder" };
  $("#trash-file-name").textContent = folder.name;
  $("#trash-action-note").textContent = "フォルダと、その中にあったデータをまとめて元に戻せます。";
  $("#permanent-delete-button").hidden = true;
  $("#trash-dialog").showModal();
}

async function restoreSelectedFile() {
  const item = state.selected;
  if (!item) return;
  try {
    const isFolder = item.trashTargetType === "folder";
    const result = await api(`/${isFolder ? "folders" : "files"}/${item.id}/restore`, { method: "POST", body: "{}" });
    $("#trash-dialog").close();
    setNotice(isFolder
      ? `フォルダを中身ごと元に戻しました（合計${Number(result.restored || 1).toLocaleString("ja-JP")}件）。`
      : "ファイルを元に戻しました。");
    await Promise.all([loadItems(), loadUsage()]);
  } catch (error) { setNotice(error.message, true); }
}

async function permanentlyDeleteSelectedFile() {
  const file = state.selected;
  if (!file || file.trashTargetType === "folder" || !state.session.canDelete || !confirm("完全に削除すると元に戻せません。削除しますか？")) return;
  try {
    await api(`/files/${file.id}/permanent`, { method: "DELETE", body: "{}" });
    await removeDeviceCopiesForFiles([file]);
    $("#trash-dialog").close();
    setNotice("完全に削除しました。");
    await Promise.all([loadItems(), loadUsage()]);
  } catch (error) { setNotice(error.message, true); }
}

async function emptyTrash() {
  const count = state.files.length + state.folders.length;
  if (!count || !state.session?.canDelete) return;
  if (!confirm(`ゴミ箱内の${count}件をすべて完全に削除します。元に戻せません。続けますか？`)) return;
  const button = $("#empty-trash-button");
  button.disabled = true;
  button.textContent = "削除中 0件";
  try {
    let totalDeleted = 0;
    let expected = 0;
    let failed = 0;
    let remaining = 1;
    while (remaining > 0 && failed === 0) {
      const result = await api("/trash", { method: "DELETE", body: "{}" });
      if (!expected) expected = Number(result.totalFiles || 0) + Number(result.totalFolders || 0);
      totalDeleted += Number(result.deleted || 0) + Number(result.deletedFolders || 0);
      failed += Number(result.failed || 0);
      remaining = Number(result.remaining || 0);
      button.textContent = expected
        ? `削除中 ${Math.min(totalDeleted, expected).toLocaleString("ja-JP")} / ${expected.toLocaleString("ja-JP")}件`
        : `削除中 ${totalDeleted.toLocaleString("ja-JP")}件`;
      if (Number(result.deleted || 0) === 0 && Number(result.deletedFolders || 0) === 0 && remaining > 0) break;
    }
    setNotice(failed || remaining
      ? `${totalDeleted}件を完全に削除しました。削除できなかったデータがあるため、ゴミ箱に残しています。`
      : `${totalDeleted}件を完全に削除しました。` , Boolean(failed || remaining));
    await Promise.all([loadItems(), loadUsage()]);
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "一括削除";
  }
}

async function openAccountDialog() {
  const dialog = $("#account-dialog");
  if (!dialog.open) dialog.showModal();
  const context = currentOfflineContext();
  if (context && navigator.onLine && globalThis.TCloudOffline?.supported()) {
    const entries = await TCloudOffline.listEntries(context.accountScope, context.rootFolderId, { offlineOnly: true }).catch(() => []);
    await syncOfflineSourceRecords(entries, context).catch(() => entries);
  }
  await refreshDeviceStorageSummary();
}

async function refreshDeviceStorageSummary() {
  const context = currentOfflineContext();
  const values = $("#device-storage-values");
  const scope = $("#device-storage-scope");
  const clearCacheButton = $("#clear-device-cache");
  const managerButton = $("#open-offline-manager");
  const permission = $("#device-storage-permission");
  syncOfflineStatusDisplay();
  if (!globalThis.TCloudOffline?.supported()) {
    scope.textContent = "このブラウザは端末保存に対応していません";
    values.hidden = true;
    clearCacheButton.hidden = true;
    managerButton.hidden = true;
    permission.hidden = true;
    return;
  }
  if (!context) {
    scope.textContent = "最上位フォルダを開き、PWを解除すると表示します";
    values.hidden = true;
    clearCacheButton.hidden = true;
    managerButton.hidden = true;
    permission.hidden = true;
    return;
  }
  scope.textContent = `${context.rootFolder.name}・この端末のみ`;
  values.hidden = false;
  try {
    const [summary, estimate, persistent] = await Promise.all([
      TCloudOffline.summary(context.accountScope, context.rootFolderId),
      TCloudOffline.storageEstimate(),
      navigator.storage?.persisted?.().catch(() => false) || false
    ]);
    $("#device-cache-usage").textContent = `${formatBytes(summary.cacheBytes)} / 最大1GB`;
    const expiry = summary.nextExpiry ? `・次回削除 ${formatOfflineExpiry(summary.nextExpiry)}` : "";
    $("#device-offline-usage").textContent = `${summary.offlineCount.toLocaleString("ja-JP")}件・${formatBytes(summary.offlineBytes)}${expiry}`;
    $("#device-storage-available").textContent = estimate.quota ? formatBytes(estimate.available) : "確認できません";
    permission.hidden = false;
    permission.textContent = persistent ? "端末保存の保護：許可済み" : "端末保存の保護：ブラウザ管理";
    clearCacheButton.hidden = summary.cacheBytes <= 0;
    managerButton.hidden = summary.offlineCount <= 0;
  } catch (error) {
    values.hidden = true;
    scope.textContent = error.message;
    clearCacheButton.hidden = true;
    managerButton.hidden = true;
    permission.hidden = true;
  }
}

async function clearCurrentDeviceCache() {
  const context = currentOfflineContext();
  if (!context || !globalThis.TCloudOffline?.supported()) return;
  if (!confirm("このフォルダの再生キャッシュを端末から削除しますか？\nオフライン保存したファイルは残ります。")) return;
  try {
    const count = await TCloudOffline.clearCache(context.accountScope, context.rootFolderId);
    setNotice(`${count.toLocaleString("ja-JP")}件分の再生キャッシュを端末から削除しました。`);
    await refreshDeviceStorageSummary();
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function openOfflineManager() {
  const context = currentOfflineContext();
  if (!context) {
    setNotice("最上位フォルダを開き、PWを解除してから操作してください。", true);
    return;
  }
  if ($("#account-dialog").open) $("#account-dialog").close();
  $("#offline-manager-scope").textContent = `${context.rootFolder.name}・この端末に保存したファイル`;
  $("#offline-manager-list").innerHTML = '<p class="offline-manager-empty">確認しています…</p>';
  $("#offline-manager-dialog").showModal();
  await loadOfflineManager(context);
}

async function loadOfflineManager(context = currentOfflineContext()) {
  const list = $("#offline-manager-list");
  if (!context) {
    list.innerHTML = '<p class="offline-manager-empty">最上位フォルダのPW解除が必要です。</p>';
    state.offlineManagerEntries = [];
    syncOfflineManagerActions();
    return;
  }
  try {
    let entries = await TCloudOffline.listEntries(context.accountScope, context.rootFolderId, { offlineOnly: true });
    entries = entries.filter((entry) => entry.complete);
    entries = await syncOfflineSourceRecords(entries, context);
    const visible = [];
    for (const entry of entries) {
      try {
        visible.push(await hydrateOfflineEntry(entry, context));
      } catch {
        // 現在解除している最上位フォルダの鍵で復号できない端末データは表示しない。
      }
    }
    visible.sort((a, b) => Number(a.entry.expiresAt || 0) - Number(b.entry.expiresAt || 0));
    state.offlineManagerEntries = visible;
    list.innerHTML = "";
    if (!visible.length) {
      list.innerHTML = '<p class="offline-manager-empty">オフライン保存したファイルはありません。</p>';
    } else {
      for (const item of visible) list.append(createOfflineManagerItem(item));
    }
    syncOfflineManagerActions();
    await refreshDeviceStorageSummary();
  } catch (error) {
    state.offlineManagerEntries = [];
    list.innerHTML = `<p class="offline-manager-empty">${escapeHtml(error.message)}</p>`;
    syncOfflineManagerActions();
  }
}

async function syncOfflineSourceRecords(entries, context) {
  if (!navigator.onLine) return entries;
  const remaining = [];
  for (const entry of entries) {
    try {
      const data = await api(`/files/${Number(entry.fileId)}`);
      const source = data.file;
      const sourceVersion = String(source?.updatedAt || source?.createdAt || "1");
      if (!source || source.deletedAt || sourceVersion !== String(entry.version)) {
        await TCloudOffline.removeEntry(entry.id);
      } else {
        remaining.push(entry);
      }
    } catch (error) {
      if ([403, 404].includes(Number(error.status))) await TCloudOffline.removeEntry(entry.id);
      else remaining.push(entry);
    }
  }
  return remaining;
}

async function hydrateOfflineEntry(entry, context) {
  const fileKey = await TRoomCrypto.unlockFileKey({
    wrappedFileKey: entry.rootWrappedFileKey,
    fileKeyIv: entry.rootFileKeyIv
  }, context.rootFolderKey);
  const metadata = await TRoomCrypto.decryptFileMetadata(entry, fileKey);
  return {
    entry,
    file: {
      id: Number(entry.fileId),
      folderId: Number(entry.folderId),
      name: metadata.name,
      mimeType: metadata.mimeType || "application/octet-stream",
      mediaKind: metadata.mediaKind || detectClientKind(metadata.mimeType || "", metadata.name),
      lastModified: Number(metadata.lastModified || 0),
      durationSeconds: normalizeDurationSeconds(metadata.durationSeconds),
      sizeBytes: Number(entry.sizeBytes || 0),
      encryptedSizeBytes: Number(entry.encryptedSizeBytes || 0),
      chunkSizeBytes: Number(entry.chunkSizeBytes || 8 * 1024 * 1024),
      chunkCount: Number(entry.chunkCount || 0),
      cryptoVersion: 1,
      encryptedMetadata: entry.encryptedMetadata,
      metadataIv: entry.metadataIv,
      fileKey,
      updatedAt: entry.version,
      createdAt: entry.completedAt,
      offlineOnly: true,
      offlineAccountScope: entry.accountScope,
      offlineRootFolderId: Number(entry.rootFolderId),
      offlineStorageId: entry.id
    }
  };
}

function createOfflineManagerItem(item) {
  const row = document.createElement("article");
  row.className = "offline-manager-item";
  row.dataset.storageId = item.entry.id;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "offline-manager-checkbox";
  checkbox.setAttribute("aria-label", `${item.file.name}を選択`);
  const copy = document.createElement("div");
  copy.className = "offline-manager-copy";
  copy.innerHTML = `<strong>${escapeHtml(item.file.name)}</strong><small>${formatBytes(item.file.sizeBytes)}・30日間保存</small>`;
  const actions = document.createElement("div");
  actions.className = "offline-manager-item-actions";
  actions.innerHTML = `<span class="offline-manager-expiry">${escapeHtml(formatOfflineExpiry(item.entry.expiresAt))}まで</span><button class="secondary-button offline-open-button" type="button" data-storage-id="${escapeHtml(item.entry.id)}">開く</button>`;
  row.append(checkbox, copy, actions);
  return row;
}

async function handleOfflineManagerClick(event) {
  const button = event.target.closest(".offline-open-button");
  if (!button) return;
  const item = state.offlineManagerEntries.find((candidate) => candidate.entry.id === button.dataset.storageId);
  if (!item) return;
  $("#offline-manager-dialog").close();
  await openPreview(item.file);
}

function selectAllOfflineEntries() {
  const boxes = $$("#offline-manager-list .offline-manager-checkbox");
  const shouldSelect = boxes.some((box) => !box.checked);
  boxes.forEach((box) => { box.checked = shouldSelect; });
  syncOfflineManagerActions();
}

function syncOfflineManagerActions() {
  const boxes = $$("#offline-manager-list .offline-manager-checkbox");
  const selected = boxes.filter((box) => box.checked).length;
  $("#offline-select-all").disabled = boxes.length === 0;
  $("#offline-select-all").textContent = boxes.length && selected === boxes.length ? "選択解除" : "すべて選択";
  $("#offline-delete-selected").disabled = selected === 0;
  $("#offline-delete-all").disabled = boxes.length === 0;
}

async function deleteSelectedOfflineEntries() {
  const ids = $$("#offline-manager-list .offline-manager-item").filter((row) => row.querySelector("input")?.checked).map((row) => row.dataset.storageId);
  if (!ids.length || !confirm(`${ids.length.toLocaleString("ja-JP")}件をこの端末のオフライン保存から削除しますか？`)) return;
  await TCloudOffline.removeEntries(ids);
  setNotice(`${ids.length.toLocaleString("ja-JP")}件を端末から削除しました。`);
  await loadOfflineManager();
}

async function deleteAllOfflineEntries() {
  const ids = state.offlineManagerEntries.map((item) => item.entry.id);
  if (!ids.length || !confirm("このフォルダのオフライン保存をすべて端末から削除しますか？")) return;
  await TCloudOffline.removeEntries(ids);
  setNotice(`${ids.length.toLocaleString("ja-JP")}件を端末から削除しました。`);
  await loadOfflineManager();
}

async function removeDeviceCopiesForFiles(files) {
  if (!globalThis.TCloudOffline?.supported() || !state.session) return;
  const accountScope = state.session.role === "admin" ? "admin" : "subadmin";
  await Promise.all((files || []).map((file) => TCloudOffline.removeFile(accountScope, Number(file.id)).catch(() => 0)));
}

async function removeDeviceCopiesForFolders(folders) {
  if (!globalThis.TCloudOffline?.supported() || !state.session) return;
  const accountScope = state.session.role === "admin" ? "admin" : "subadmin";
  const topFolders = (folders || []).filter((folder) => folder.parentId == null);
  await Promise.all(topFolders.map((folder) => TCloudOffline.removeRoot(accountScope, Number(folder.id)).catch(() => 0)));
  if (topFolders.length === (folders || []).length) return;
  const context = currentOfflineContext();
  if (!context) return;
  const entries = await TCloudOffline.listEntries(context.accountScope, context.rootFolderId, { offlineOnly: true });
  await syncOfflineSourceRecords(entries, context);
}

function formatOfflineExpiry(value) {
  const date = new Date(Number(value));
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function loadUsage() {
  if (state.session?.role !== "admin") return;
  try {
    const usage = await api("/usage");
    $("#usage-text").textContent = formatBytes(usage.activeBytes);
    $("#file-count").textContent = `${usage.activeFileCount.toLocaleString("ja-JP")}ファイル`;
    $("#trash-usage-text").textContent = formatBytes(usage.trashBytes);
    $("#trash-file-count").textContent = `${usage.trashFileCount.toLocaleString("ja-JP")}ファイル`;
    $("#mobile-active-usage").textContent = `${usage.activeFileCount.toLocaleString("ja-JP")}ファイル・${formatBytes(usage.activeBytes)}`;
    $("#mobile-trash-usage").textContent = `${usage.trashFileCount.toLocaleString("ja-JP")}ファイル・${formatBytes(usage.trashBytes)}`;
  } catch {}
}

async function openUsageDetails() {
  if (state.session?.role !== "admin") return;
  if ($("#account-dialog").open) $("#account-dialog").close();
  const dialog = $("#usage-details-dialog");
  const list = $("#usage-details-list");
  list.innerHTML = '<p class="usage-details-empty">集計しています…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api("/usage-details");
    const folders = data.folders || [];
    list.innerHTML = "";
    if (!folders.length) {
      list.innerHTML = '<p class="usage-details-empty">最上位フォルダがありません。</p>';
      return;
    }
    for (const folder of folders) {
      const row = document.createElement("article");
      row.className = "usage-details-row";
      row.innerHTML = `<strong>${escapeHtml(folder.name || "名称なし")}</strong><span>${formatBytes(folder.sizeBytes)}</span><small>${Number(folder.fileCount || 0).toLocaleString("ja-JP")}ファイル</small>`;
      list.append(row);
    }
  } catch (error) {
    list.innerHTML = `<p class="usage-details-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function loadDeletionRequestCount() {
  try {
    const data = await api("/deletion-requests");
    const count = Number(data.count || 0);
    for (const id of ["#desktop-request-count", "#mobile-request-count"]) {
      const badge = $(id);
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count === 0;
    }
    if (count > 0 && state.view !== "requests") setNotice(`削除申請が${count}件あります。`);
  } catch {}
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (!options.rawBody) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...options, headers, credentials: "same-origin" });
  const type = response.headers.get("Content-Type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && state.session) location.reload();
    const error = new Error(data?.error || `通信に失敗しました（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function handleError(error) { setNotice(error.message, true); }
function showLoginError(message) { $("#login-error").textContent = message; }
function setNotice(message, error = false) { const node = $("#notice"); node.textContent = message; node.style.color = error ? "#b63f46" : ""; }
function kindSymbol(kind) { return ({ image: "▧", video: "▶", audio: "♪", document: "▤", other: "□" })[kind] || "□"; }
function kindLabel(kind) { return ({ image: "写真", video: "動画", audio: "音声", document: "書類", other: "ファイル" })[kind] || "ファイル"; }
function detectClientKind(mime, name) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/") || /\.(mp4|m4v|flv|mkv|mov|avi|webm|mpg|mpeg|mxf|gxf|lxf|3gp|ts|m2ts|mts)$/i.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(m4a|mp3|wav|aac|flac|ogg)$/i.test(name)) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/i.test(name)) return "document";
  return "other";
}
function isBlockedClientFile(file) {
  return /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|reg|apk|app|dmg|pkg)$/i.test(file.name)
    || ["application/x-msdownload", "application/x-sh", "application/x-executable"].includes(file.type);
}
function cleanEditableName(value) {
  const name = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 240 || name === "." || name === "..") throw new Error("名前を確認してください。");
  return name;
}
function formatBytes(bytes) { const value = Number(bytes || 0); if (value < 1024) return `${value} B`; const units = ["KB", "MB", "GB", "TB"]; let size = value / 1024; let i = 0; while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; } return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[i]}`; }
function normalizeDurationSeconds(value) { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds)) : null; }
function formatMediaDuration(value) { const total = normalizeDurationSeconds(value); if (!total) return ""; const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`; }
function formatMediaDetails(file) { const media = ["video", "audio"].includes(file?.mediaKind); const duration = media ? formatMediaDuration(file.durationSeconds) : ""; if (duration) return `${formatBytes(file.sizeBytes)}・${duration}`; if (media && file?.durationPending) return `${formatBytes(file.sizeBytes)}・確認中`; if (media && file?.durationUnavailable) return `${formatBytes(file.sizeBytes)}・時間不明`; return formatBytes(file?.sizeBytes); }
function formatDate(value) { if (!value) return "—"; const date = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")); return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric" }).format(date); }
function formatDateTime(value) { if (!value) return "—"; const date = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")); return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function formatEpoch(value) { const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "—"; }
function localDateTimeValue(value) { const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
async function copyText(value, successMessage = "コピーしました。") {
  if (!value) throw new Error("コピーする内容がありません。");
  await navigator.clipboard.writeText(value);
  setNotice(successMessage);
}
function escapeHtml(value) { return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]); }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }

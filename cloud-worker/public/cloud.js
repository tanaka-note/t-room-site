const API = "/cloud/api";
const REMEMBER_LOGIN_KEY = "tcloud-login-remember";
const VAULT_CACHE_DB = "tcloud-device-vault";
const VAULT_CACHE_STORE = "crypto-keys";
const state = {
  session: null,
  loginId: "",
  folderId: null,
  kind: "",
  view: "all",
  sort: "updated",
  sortDirection: "desc",
  query: "",
  files: [],
  folders: [],
  folderSummary: null,
  history: [],
  requests: [],
  shares: [],
  selected: null,
  selectedFolder: null,
  shareTarget: null,
  listMode: false,
  selectedFiles: new Map(),
  selectedFolders: new Map(),
  selectionHistoryActive: false,
  moveDestinations: new Map(),
  selecting: false,
  dragDepth: 0,
  uploading: false,
  uploadAbort: null,
  downloadAbort: null,
  wakeLock: null,
  downloadActive: false,
  previewUrl: "",
  previewMediaToken: "",
  previewPlayer: null,
  previewFileId: null,
  previewHistoryActive: false,
  previewTouchStart: null,
  folderUploadSelection: null,
  thumbnailAttempts: new Set(),
  thumbnailBackfillRunning: false,
  handlingPopState: false,
  historyReady: false,
  folderNamesMigrated: false,
  crypto: { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
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
}

function bindEvents() {
  $("#login-form").addEventListener("submit", login);
  $("#toggle-password").addEventListener("click", () => {
    const input = $("#login-password");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggle-password").setAttribute("aria-label", input.type === "password" ? "パスワードを表示" : "パスワードを隠す");
  });
  $("#remember-login").addEventListener("change", syncLoginAutocomplete);
  $("#logout-button").addEventListener("click", logout);
  $("#vault-logout-button").addEventListener("click", logout);
  $("#mobile-account-button").addEventListener("click", () => $("#account-dialog").showModal());
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
  $("#folder-upload-form").addEventListener("submit", uploadSelectedFolder);
  $("#unlock-form").addEventListener("submit", unlockFolder);
  $("#folder-settings-form").addEventListener("submit", saveFolderSettings);
  $("#folder-password-action").addEventListener("change", toggleFolderPasswordInput);
  $("#delete-folder-button").addEventListener("click", deleteSelectedFolder);
  $("#edit-form").addEventListener("submit", saveFile);
  $("#edit-file-button").addEventListener("click", openEditDialog);
  $("#delete-file-button").addEventListener("click", deleteSelectedFile);
  $("#share-file-button").addEventListener("click", () => openShareDialog("file", state.selected));
  $("#share-folder-button").addEventListener("click", () => openShareDialog("folder", state.selectedFolder));
  $("#share-form").addEventListener("submit", createShare);
  $("#toggle-share-password").addEventListener("click", toggleSharePassword);
  $("#generate-share-password").addEventListener("click", generateSharePassword);
  $("#copy-share-url").addEventListener("click", () => copyText($("#share-result-url").value, "共有URLをコピーしました。").catch((error) => setNotice(error.message, true)));
  $("#copy-share-password").addEventListener("click", () => copyText($("#share-result-password").value, "共有パスワードをコピーしました。").catch((error) => setNotice(error.message, true)));
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
  $("#preview-fullscreen").addEventListener("click", togglePreviewFullscreen);
  $("#preview-stage-wrap").addEventListener("dblclick", handlePreviewDoubleClick);
  $("#preview-stage-wrap").addEventListener("touchstart", handlePreviewTouchStart, { passive: true });
  $("#preview-stage-wrap").addEventListener("touchend", handlePreviewTouchEnd, { passive: true });
  document.addEventListener("fullscreenchange", syncPreviewFullscreenButton);
  document.addEventListener("keydown", handlePreviewKeydown);
  window.addEventListener("popstate", handleHistoryNavigation);
  $("#search-input").addEventListener("input", debounce((event) => { state.query = event.target.value.trim(); loadItems(); }, 250));
  $$("#sort-controls [data-sort-key]").forEach((button) => button.addEventListener("click", () => changeSort(button.dataset.sortKey)));
  $("#display-toggle").addEventListener("click", () => { state.listMode = !state.listMode; renderItems(); });
  $("#selection-clear").addEventListener("click", () => clearFileSelection());
  $("#selection-all").addEventListener("click", selectAllVisibleItems);
  $("#selection-download").addEventListener("click", startSelectedDownloads);
  $("#selection-share").addEventListener("click", () => {
    const files = [...state.selectedFiles.values()];
    if (state.selectedFolders.size) return;
    if (files.length === 1) openShareDialog("file", files[0]);
    else if (files.length > 1) openShareDialog("selection", files);
  });
  $("#selection-move").addEventListener("click", openMoveDialog);
  $("#selection-delete").addEventListener("click", deleteSelectedItems);
  $("#move-form").addEventListener("submit", moveSelectedItems);
  $("#upload-cancel").addEventListener("click", cancelUploads);
  $("#download-cancel").addEventListener("click", cancelDownloads);
  $("#download-close").addEventListener("click", closeDownloadDialog);
  $("#download-retry-wake").addEventListener("click", requestDownloadWakeLock);
  $("#keep-screen-awake").addEventListener("change", async (event) => {
    if (event.target.checked && state.downloadActive) await requestDownloadWakeLock();
    else await releaseDownloadWakeLock();
  });
  document.addEventListener("visibilitychange", handleDownloadVisibility);
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

function syncLoginAutocomplete() {
  const remember = $("#remember-login").checked;
  $("#login-id").setAttribute("autocomplete", remember ? "username" : "off");
  $("#login-password").setAttribute("autocomplete", remember ? "current-password" : "off");
}

function changeSort(key) {
  if (!["updated", "name", "size"].includes(key)) return;
  if (state.sort === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  else {
    state.sort = key;
    state.sortDirection = key === "name" ? "asc" : "desc";
  }
  syncSortControls();
  loadItems();
}

function syncSortControls() {
  $$("#sort-controls [data-sort-key]").forEach((button) => {
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

function droppedDirectoryExists(dataTransfer) {
  return [...(dataTransfer?.items || [])].some((item) => {
    if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") return false;
    return Boolean(item.webkitGetAsEntry()?.isDirectory);
  });
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
  if (droppedDirectoryExists(event.dataTransfer)) {
    try {
      const selection = await folderSelectionFromDrop(event.dataTransfer);
      openFolderUploadDialog(selection);
    } catch (error) {
      setNotice(error.message, true);
    }
    return;
  }
  if (!state.folderId) {
    setNotice("ファイルだけを追加する場合は、保存先のフォルダを開いてください。", true);
    return;
  }
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) {
    setNotice("アップロードするファイルを確認してください。", true);
    return;
  }
  uploadFiles(files);
}

function handleFolderInput(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  try {
    const selection = normalizeFolderSelection(files.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
    openFolderUploadDialog(selection);
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function folderSelectionFromDrop(dataTransfer) {
  const records = [];
  const directories = new Set();
  for (const item of [...(dataTransfer?.items || [])]) {
    if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) await collectDroppedEntry(entry, "", records, directories);
  }
  return normalizeFolderSelection(records, directories);
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

function openFolderUploadDialog(selection) {
  if (!selection?.roots?.length || state.uploading) return;
  state.folderUploadSelection = selection;
  const atStorageRoot = !state.folderId;
  $("#folder-upload-summary").textContent = `${selection.roots.join("、")}（${selection.files.length.toLocaleString("ja-JP")}ファイル）を、フォルダ構成を保って保存します。`;
  $("#folder-upload-password-row").hidden = !atStorageRoot;
  $("#folder-upload-password-note").hidden = !atStorageRoot;
  $("#folder-upload-inherit-note").hidden = atStorageRoot;
  $("#folder-upload-password").required = atStorageRoot;
  $("#folder-upload-password").value = "";
  $("#folder-upload-error").textContent = "";
  $("#folder-upload-dialog").showModal();
}

function openFolderDialog() {
  const inheritsProtection = Boolean(state.folderId);
  $("#folder-password-row").hidden = inheritsProtection;
  $("#folder-password-note").hidden = inheritsProtection;
  $("#folder-inherit-note").hidden = !inheritsProtection;
  $("#folder-password").required = !inheritsProtection;
  $("#folder-password").value = "";
  $("#folder-dialog").showModal();
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
  const permissionText = session.role === "admin" ? "すべての操作が可能" : "閲覧・アップロード・削除・解除済みフォルダ内の名前変更";
  $("#account-permission").textContent = permissionText;
  $("#mobile-account-name").textContent = session.accountName;
  $("#mobile-account-permission").textContent = permissionText;
  $("#edit-file-button").hidden = !session.canEditFiles && !session.canRenameUnlockedItems;
  $("#delete-file-button").hidden = !session.canDelete && !session.canTrashUnlockedFiles;
  $$('[data-view="trash"]').forEach((button) => { button.hidden = !session.canDelete; });
  $$('[data-view="history"]').forEach((button) => { button.hidden = !session.canViewHistory; });
  $$('[data-view="shares"]').forEach((button) => { button.hidden = session.role !== "admin"; });
  $("#share-file-button").hidden = session.role !== "admin";
  $("#share-folder-button").hidden = session.role !== "admin";
  syncAvailableActions();
  $("#storage-meter").hidden = session.role !== "admin";
  $("#mobile-storage-summary").hidden = session.role !== "admin";
  if (session.role === "admin") loadUsage();
  initializeNavigationHistory();
  await prepareCryptoSession(password, accountKey);
  await migrateLegacyFolderNames();
  await loadItems();
}

async function logout() {
  state.crypto = { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false };
  await clearCachedAdminKeys();
  await api("/logout", { method: "POST", body: "{}" });
  location.reload();
}

function initializeNavigationHistory() {
  if (state.historyReady) return;
  history.replaceState({ tcloud: true, folderId: null, folderName: "フォルダ", previewId: null }, "", location.href);
  state.historyReady = true;
}

async function navigateToFolder(folderId, folderName, options = {}) {
  const { pushHistory = true, load = true } = options;
  const replaceSelectionHistory = pushHistory && state.selectionHistoryActive;
  if (replaceSelectionHistory) {
    clearFileSelection(true, false);
    state.selectionHistoryActive = false;
  }
  state.folderId = folderId ? Number(folderId) : null;
  state.kind = "";
  state.view = "all";
  clearSearch();
  $("#view-title").textContent = folderName || (state.folderId ? "ファイル" : "フォルダ");
  if (pushHistory && state.historyReady) {
    const entry = { tcloud: true, folderId: state.folderId, folderName: $("#view-title").textContent, previewId: null };
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
    if (state.selectedFiles.size || state.selectedFolders.size) {
      state.selectionHistoryActive = false;
      clearFileSelection(true, false);
      const sameFolder = Number(target.folderId || 0) === Number(state.folderId || 0);
      if (sameFolder && !target.previewId) return;
    }
    state.previewHistoryActive = false;
    if ($("#preview-dialog").open) $("#preview-dialog").close();
    await navigateToFolder(target.folderId, target.folderName, { pushHistory: false });
    if (target.previewId) {
      const file = state.files.find((item) => Number(item.id) === Number(target.previewId));
      if (file) await openPreview(file, { pushHistory: false });
    }
  } finally {
    state.handlingPopState = false;
  }
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
      await migrateLegacyFolderNames();
      await loadItems();
    } else {
      const privateKey = await TRoomCrypto.unlockAdminPrivateKey(accountKey, state.crypto.config);
      state.crypto.accountKey = accountKey;
      state.crypto.adminPrivateKey = privateKey;
      await saveCachedAdminKey(state.crypto.config, privateKey);
      $("#vault-dialog").close();
      setCryptoStatus("暗号化鍵：解除済み", true);
      setNotice("暗号化鍵を解除しました。");
      await migrateLegacyFolderNames();
      await loadItems();
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

function isLegacyFolderName(name) {
  return !String(name || "").trim() || name === "[encrypted]";
}

async function migrateLegacyFolderNames() {
  if (state.folderNamesMigrated || state.session?.role !== "admin" || !state.crypto.adminPrivateKey) return;
  try {
    await migrateLegacyFolderBranch(null);
    state.folderNamesMigrated = true;
  } catch (error) {
    console.warn("Folder name migration was deferred.", error);
  }
}

async function migrateLegacyFolderBranch(parentId) {
  const params = new URLSearchParams();
  if (parentId) params.set("folderId", parentId);
  const data = await api(`/items?${params}`);
  for (const folder of data.folders || []) {
    const key = await ensureAdminFolderKey(folder);
    if (isLegacyFolderName(folder.name)) {
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
      folder.name = plaintextName;
    }
    await migrateLegacyFolderBranch(folder.id);
  }
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
  } else if (["trash", "history", "requests", "shares"].includes(button.dataset.view)) {
    state.folderId = null;
    state.kind = "";
    clearSearch();
  } else {
    state.kind = button.dataset.kind || "";
  }
  state.view = button.dataset.view || "all";
  const labels = { all: state.folderId ? "ファイル" : "フォルダ", trash: "ゴミ箱", history: "操作履歴", requests: "削除申請", shares: "共有管理", image: "写真", video: "動画", audio: "音声", document: "書類" };
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
  $("#search-input").value = "";
}

function syncAvailableActions() {
  const inTrash = state.view === "trash";
  const inHistory = state.view === "history";
  const inRequests = state.view === "requests";
  const inShares = state.view === "shares";
  const insideFolder = Boolean(state.folderId);
  $("#new-folder-button").hidden = inTrash || inHistory || inRequests || inShares;
  $("#new-folder-button").disabled = !state.crypto.publicKey;
  $("#upload-button").hidden = inTrash || inHistory || inRequests || inShares || !state.session?.canUpload;
  $("#upload-button").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#desktop-folder-upload-action").hidden = !state.session?.canUpload;
  $("#desktop-folder-upload-action").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#download-folder-button").hidden = !insideFolder || inTrash || inHistory || inRequests || inShares || !("showDirectoryPicker" in window);
  $("#download-folder-button").disabled = state.downloadActive;
  $("#mobile-add-button").hidden = inTrash || inHistory || inRequests || inShares;
  $("#mobile-upload-action").hidden = !insideFolder || !state.session?.canUpload;
  $("#mobile-upload-action").disabled = !state.crypto.fileEncryptionReady || state.uploading;
  $("#toolbar").hidden = inHistory || inRequests || inShares;
  $("#search-input").placeholder = insideFolder ? "ファイル名を検索" : "フォルダ名を検索";
  $$('[data-kind]').forEach((button) => { button.disabled = !insideFolder || inTrash || inHistory || inRequests || inShares; });
}

async function loadItems() {
  clearFileSelection(false);
  setNotice("");
  state.folderSummary = null;
  try {
    if (state.view === "trash") {
      const data = await api("/trash");
      state.folders = (await hydrateFolderRecords(data.folders || [])).map((folder) => ({ ...folder, trashed: true }));
      state.files = (await hydrateFileRecords(data.files || [])).map((file) => ({ ...file, trashed: true }));
      state.history = [];
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs([]);
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
      state.folderSummary = state.folderId ? {
        fileCount: Number(data.folder?.fileCount || 0),
        folderCount: Number(data.folder?.folderCount || 0)
      } : null;
      state.folders = await hydrateFolderRecords(data.folders || []);
      state.files = await hydrateFileRecords(data.files || []);
      state.history = [];
      state.requests = [];
      state.shares = [];
      renderBreadcrumbs(await hydrateFolderRecords(data.breadcrumbs || []));
    }
    renderItems();
  } catch (error) {
    handleError(error);
  }
}

function renderItems() {
  renderFolderSummary();
  const grid = $("#content-grid");
  grid.classList.toggle("list-mode", state.listMode || state.view === "history" || state.view === "requests" || state.view === "shares");
  grid.innerHTML = "";
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
  $("#empty-state").hidden = state.folders.length + state.files.length + state.history.length + state.requests.length + state.shares.length > 0;
  $("#empty-title").textContent = state.view === "requests" ? "削除申請はありません" : state.view === "history" ? "履歴がありません" : state.view === "shares" ? "共有URLはありません" : state.view === "trash" ? "ゴミ箱は空です" : (state.folderId ? "ファイルがありません" : "フォルダがありません");
  $("#empty-copy").textContent = state.view === "requests"
    ? "副管理者から申請が届くと、ここに表示されます。"
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
  scheduleMissingVideoThumbnails();
}

function renderFolderSummary() {
  const summary = $("#view-summary");
  const visible = state.view === "all" && Boolean(state.folderId) && Boolean(state.folderSummary);
  summary.hidden = !visible;
  summary.textContent = visible ? formatFolderCount(state.folderSummary) : "";
}

function formatFolderCount(folder) {
  return `${Number(folder.fileCount || 0)}ファイル・${Number(folder.folderCount || 0)}フォルダ`;
}

function canRenameFolder(folder) {
  if (state.session?.canEditFolders) return true;
  return Boolean(state.session?.canRenameUnlockedItems && folder?.isUnlocked && state.crypto.folderKeys.has(Number(folder.id)));
}

function canRenameFile(file) {
  if (state.session?.canEditFiles) return true;
  return Boolean(state.session?.canRenameUnlockedItems && !file?.trashed && file?.fileKey && state.crypto.folderKeys.has(Number(file.folderId)));
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
  if (canRenameFolder(folder)) {
    card.classList.add("has-settings");
    const settings = document.createElement("button");
    settings.className = "folder-settings-button";
    settings.type = "button";
    settings.setAttribute("aria-label", `${folder.name}の設定`);
    settings.textContent = "⋯";
    settings.addEventListener("click", (event) => { event.stopPropagation(); openFolderSettings(folder); });
    card.append(settings);
  }
  if (state.selectedFolders.has(folder.id)) card.classList.add("selected", "selection-pass");
  return card;
}

async function hydrateFolderRecords(records) {
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
  if (state.query) result = result.filter((folder) => folder.name.toLocaleLowerCase("ja").includes(state.query.toLocaleLowerCase("ja")));
  const direction = state.sortDirection === "asc" ? 1 : -1;
  if (state.sort === "name") result.sort((a, b) => direction * a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
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

function toggleSharePassword() {
  const input = $("#share-password");
  input.type = input.type === "password" ? "text" : "password";
  $("#toggle-share-password").setAttribute("aria-label", input.type === "password" ? "共有パスワードを表示" : "共有パスワードを隠す");
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
    try { await copyText(url, "共有URLを発行し、URLをコピーしました。"); }
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
  $("#generated-share-password").textContent = "";
  $("#generated-share-password").hidden = true;
  state.shareTarget = null;
}

function clearShareResultSecrets() {
  $("#share-result-url").value = "";
  $("#share-result-password").value = "";
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
  $("#folder-settings-id").value = folder.id;
  $("#folder-settings-name").value = folder.name;
  $("#folder-password-action").value = "keep";
  $("#folder-new-password").value = "";
  $("#folder-settings-error").textContent = "";
  $("#delete-folder-button").hidden = !state.session.canDelete;
  const inheritsProtection = Boolean(folder.parentId && !folder.isProtected);
  const canEditPassword = Boolean(state.session.canEditFolders);
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
  const passwordAction = !state.session.canEditFolders || (state.selectedFolder?.parentId && !state.selectedFolder?.isProtected) ? "keep" : $("#folder-password-action").value;
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
    await loadItems();
  } catch (error) { $("#folder-settings-error").textContent = error.message; }
}

async function deleteSelectedFolder() {
  const folder = state.selectedFolder;
  if (!folder || !state.session.canDelete || !confirm(`「${folder.name}」を中身ごとゴミ箱へ移動しますか？`)) return;
  const button = $("#delete-folder-button");
  button.disabled = true;
  button.textContent = "ゴミ箱へ移動中…";
  try {
    const result = await api(`/folders/${folder.id}`, { method: "DELETE", body: "{}" });
    $("#folder-settings-dialog").close();
    setNotice(`フォルダを中身ごとゴミ箱へ移動しました（合計${Number(result.deleted || 1).toLocaleString("ja-JP")}件）。`);
    await Promise.all([loadItems(), loadUsage()]);
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
    <div class="file-copy"><strong>${escapeHtml(file.name)}</strong><span class="file-meta"><span>${formatBytes(file.sizeBytes)}</span><span>${formatDate(file.createdAt || file.deletedAt)}</span></span></div>`;
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

async function hydrateFileRecords(records) {
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
        } catch {
          file.name = "復号できないファイル";
          file.mimeType = "application/octet-stream";
          file.mediaKind = "other";
        }
      }
    }
    hydrated.push(file);
  }
  let result = hydrated;
  if (state.query) result = result.filter((file) => file.name.toLocaleLowerCase("ja").includes(state.query.toLocaleLowerCase("ja")));
  if (state.kind) result = result.filter((file) => file.mediaKind === state.kind);
  const direction = state.sortDirection === "asc" ? 1 : -1;
  if (state.sort === "name") result.sort((a, b) => direction * a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
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
    }, state.selectedFiles.size || state.selectedFolders.size ? 80 : 380);
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
    if (started) event.preventDefault();
    state.selecting = false;
    pointerId = null;
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function installFolderLongPressSelection(card, folder) {
  let timer = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".folder-settings-button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      card.dataset.longPressed = "true";
      selectFolder(folder, card);
      if (navigator.vibrate) navigator.vibrate(18);
    }, state.selectedFiles.size || state.selectedFolders.size ? 80 : 380);
  });
  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) stop();
  });
  card.addEventListener("pointerup", stop);
  card.addEventListener("pointercancel", stop);
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
  const fileCount = state.selectedFiles.size;
  const folderCount = state.selectedFolders.size;
  const count = fileCount + folderCount;
  $("#selection-count").textContent = `${count.toLocaleString("ja-JP")}件を選択中`;
  $("#selection-bar").hidden = count === 0;
  $("#selection-download").disabled = fileCount === 0;
  $("#selection-share").hidden = state.session?.role !== "admin" || fileCount < 1 || folderCount !== 0;
  $("#selection-move").hidden = !state.session?.canEditFiles || !state.session?.canEditFolders;
  $("#selection-move").disabled = count === 0;
  const canDeleteSelection = Boolean((fileCount && (state.session?.canDelete || state.session?.canTrashUnlockedFiles)) || (folderCount && state.session?.canDelete));
  $("#selection-delete").hidden = !canDeleteSelection;
  $("#selection-delete").disabled = count === 0;
  $("#selection-delete").textContent = "削除";
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

async function deleteSelectedItems() {
  const files = [...state.selectedFiles.values()];
  const folders = [...state.selectedFolders.values()];
  const count = files.length + folders.length;
  if (!count) return;
  const folderNote = folders.length ? "\nフォルダは中身ごとゴミ箱へ移動します。" : "";
  const message = state.session?.canDelete
    ? `${count}件を削除しますか？ファイルはゴミ箱へ移動します。${folderNote}`
    : `${files.length}件を本当に削除しますか？`;
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  const button = $("#selection-delete");
  button.disabled = true;
  button.textContent = `削除中 0 / ${count}`;
  let completed = 0;
  let movedEntries = 0;
  let processed = 0;
  const failures = [];
  try {
    let nextFileIndex = 0;
    const fileWorker = async () => {
      while (nextFileIndex < files.length) {
        const file = files[nextFileIndex++];
        try {
          await api(`/files/${file.id}`, { method: "DELETE", body: "{}" });
          completed += 1;
          movedEntries += 1;
        } catch (error) {
          failures.push({ name: file.name, error });
        }
        processed += 1;
        button.textContent = `削除中 ${processed} / ${count}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => fileWorker()));
    if (state.session?.canDelete) {
      for (const folder of folders) {
        try {
          const result = await api(`/folders/${folder.id}`, { method: "DELETE", body: "{}" });
          completed += 1;
          movedEntries += Number(result.deleted || 1);
        } catch (error) {
          failures.push({ name: folder.name, error });
        }
        processed += 1;
        button.textContent = `削除中 ${processed} / ${count}`;
      }
    }
    clearFileSelection();
    const failedNames = failures.slice(0, 3).map((item) => item.name).join("、");
    setNotice(failures.length
      ? `${completed}件を処理しました。削除できなかった${failures.length}件：${failedNames}${failures.length > 3 ? " ほか" : ""}`
      : `${completed}件の選択から、合計${movedEntries.toLocaleString("ja-JP")}件をゴミ箱へ移動しました。`, Boolean(failures.length));
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
  if (!state.session?.canEditFiles || !state.session?.canEditFolders) return;
  const select = $("#move-destination");
  const submit = $("#move-submit");
  $("#move-error").textContent = "";
  $("#move-copy").textContent = `${files.length + folders.length}件の移動先を選択してください。`;
  select.innerHTML = '<option value="">読み込み中…</option>';
  select.disabled = true;
  submit.disabled = true;
  $("#move-dialog").showModal();
  try {
    const destinations = await collectMoveDestinations();
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
    $("#move-error").textContent = error.message;
  }
}

async function collectMoveDestinations(parentId = null, path = [], ancestorIds = [], output = []) {
  const params = new URLSearchParams({ sort: "name" });
  if (parentId) params.set("folderId", String(parentId));
  const data = await api(`/items?${params}`);
  const folders = [...(data.folders || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
  for (const folder of folders) {
    const nextPath = [...path, folder.name];
    output.push({ folder, label: nextPath.join(" / "), ancestorIds: [...ancestorIds] });
    await collectMoveDestinations(Number(folder.id), nextPath, [...ancestorIds, Number(folder.id)], output);
  }
  return output;
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
  const destination = destinationId ? state.moveDestinations.get(destinationId) : null;
  const submit = $("#move-submit");
  submit.disabled = true;
  submit.textContent = "移動中…";
  let completed = 0;
  let failed = 0;
  try {
    const destinationKey = destination ? await ensureAdminFolderKey(destination) : null;
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
        const folderKey = await ensureAdminFolderKey(folder);
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
  if ($("#keep-screen-awake").checked) await requestDownloadWakeLock();
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
    await releaseDownloadWakeLock();
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
  list.innerHTML = failures.map(({ file, error }) => `<li><strong>${escapeHtml(file.downloadDisplayName || file.name)}</strong>${error?.message ? ` — ${escapeHtml(error.message)}` : ""}</li>`).join("");
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

async function requestDownloadWakeLock() {
  $("#download-retry-wake").hidden = true;
  if (!("wakeLock" in navigator)) {
    $("#wake-lock-status").textContent = "このブラウザは消灯防止に対応していません。端末の画面設定をご確認ください。";
    return;
  }
  if (document.visibilityState !== "visible") {
    $("#wake-lock-status").textContent = "画面へ戻ると消灯防止を再開します。";
    return;
  }
  try {
    if (!state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
        if (state.downloadActive && $("#keep-screen-awake").checked && document.visibilityState === "visible") {
          $("#wake-lock-status").textContent = "消灯防止が解除されました。再試行できます。";
          $("#download-retry-wake").hidden = false;
        }
      }, { once: true });
    }
    $("#wake-lock-status").textContent = "ダウンロード中の消灯を防止しています。";
  } catch {
    $("#wake-lock-status").textContent = "省電力設定などにより消灯防止を開始できませんでした。";
    $("#download-retry-wake").hidden = false;
  }
}

async function releaseDownloadWakeLock() {
  if (state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    try { await lock.release(); } catch {}
  }
  if (!state.downloadActive) $("#wake-lock-status").textContent = "端末が対応している場合に有効になります。";
}

async function handleDownloadVisibility() {
  if (document.visibilityState === "visible" && state.downloadActive && $("#keep-screen-awake").checked) {
    await requestDownloadWakeLock();
  }
}

function renderBreadcrumbs(items) {
  const nav = $("#breadcrumbs");
  if (state.view === "trash") { nav.textContent = "完全削除または復元するまで、ファイルはゴミ箱に保持されます。"; return; }
  if (state.view === "history") { nav.textContent = state.session?.role === "admin" ? "管理者・副管理者のアップロード／ダウンロード履歴です。" : "副管理者本人のアップロード／ダウンロード履歴です。"; return; }
  if (state.view === "requests") { nav.textContent = "承認するまでファイルは削除されず、通常どおり利用できます。"; return; }
  if (state.view === "shares") { nav.textContent = "共有URLの発行状況・期限・停止・利用履歴を管理できます。"; return; }
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
  const selection = state.folderUploadSelection;
  if (!selection || state.uploading) return;
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  let dialogClosed = false;
  $("#folder-upload-error").textContent = "";
  try {
    if (!state.crypto.publicKey || !state.crypto.fileEncryptionReady) throw new Error("暗号化の初期設定を完了してください。");
    const baseParentId = state.folderId ? Number(state.folderId) : null;
    const baseParentKey = baseParentId ? state.crypto.folderKeys.get(baseParentId) : null;
    if (baseParentId && !baseParentKey) throw new Error("保存先フォルダの暗号化鍵を解除してください。");
    const rootPassword = baseParentId ? "" : $("#folder-upload-password").value;
    if (!baseParentId && rootPassword.length < 4) throw new Error("フォルダパスワードは4文字以上で設定してください。");

    state.uploading = true;
    submitButton.disabled = true;
    syncAvailableActions();
    const panel = $("#upload-panel");
    panel.hidden = false;
    panel.classList.remove("upload-complete", "upload-error");
    $("#upload-heading").textContent = "フォルダ構成を作成中";
    $("#upload-file-name").textContent = selection.roots.join("、");
    $("#upload-file-progress").textContent = "準備中…";
    $("#upload-progress").style.width = "0%";
    state.folderUploadSelection = null;
    $("#folder-upload-password").value = "";
    $("#folder-upload-dialog").close();
    dialogClosed = true;

    const foldersByPath = new Map();
    for (let index = 0; index < selection.directories.length; index++) {
      const path = selection.directories[index];
      const parts = path.split("/");
      const parentPath = parts.slice(0, -1).join("/");
      const inheritedParent = parentPath ? foldersByPath.get(parentPath) : { id: baseParentId, key: baseParentKey };
      if (!inheritedParent) throw new Error(`${path} の親フォルダを作成できませんでした。`);
      const password = !inheritedParent.id ? rootPassword : "";
      const created = await createEncryptedFolder(parts.at(-1), inheritedParent.id, inheritedParent.key, password);
      foldersByPath.set(path, created);
      const completed = index + 1;
      const percent = Math.round(completed / selection.directories.length * 100);
      $("#upload-status").textContent = `${completed} / ${selection.directories.length}フォルダ作成`;
      $("#upload-file-progress").textContent = `${percent}%`;
      $("#upload-progress").style.width = `${percent}%`;
    }

    const destinations = new Map();
    for (const record of selection.files) {
      const folderPath = record.relativePath.split("/").slice(0, -1).join("/");
      const destination = foldersByPath.get(folderPath);
      if (!destination) throw new Error(`${record.relativePath} の保存先を作成できませんでした。`);
      destinations.set(record.file, { folderId: destination.id, folderKey: destination.key });
    }

    state.uploading = false;
    submitButton.disabled = false;
    syncAvailableActions();
    if (selection.files.length) await uploadFiles(selection.files.map((record) => record.file), destinations);
    else {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = "フォルダ作成完了";
      $("#upload-file-progress").textContent = "保存完了";
      await Promise.all([loadItems(), loadUsage()]);
    }
  } catch (error) {
    state.uploading = false;
    submitButton.disabled = false;
    syncAvailableActions();
    $("#upload-panel").classList.add("upload-error");
    if (dialogClosed) setNotice(`フォルダの保存に失敗しました：${error.message}`, true);
    else $("#folder-upload-error").textContent = error.message;
  }
}

async function createEncryptedFolder(name, parentId, parentKey, password = "") {
  const encrypted = await TRoomCrypto.createFolderPackage(name, password, state.crypto.publicKey, parentKey);
  const result = await api("/folders", {
    method: "POST",
    body: JSON.stringify({ ...encrypted.payload, name: encrypted.name, parentId })
  });
  const created = { id: Number(result.id), key: encrypted.folderKey };
  state.crypto.folderKeys.set(created.id, created.key);
  return created;
}

async function uploadFiles(files, destinations = null) {
  if (!files.length || !state.session.canUpload) return;
  if (state.uploading) {
    setNotice("アップロードが完了してから、次のファイルを追加してください。", true);
    return;
  }
  if (!state.crypto.fileEncryptionReady) {
    setNotice("暗号化の初期設定を完了してください。", true);
    return;
  }
  $("#file-input").value = "";
  state.uploading = true;
  state.uploadAbort = new AbortController();
  syncAvailableActions();
  const panel = $("#upload-panel");
  const total = files.length;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const connectionLimit = getUploadConnectionLimit();
  const fileLimit = Math.min(getUploadFileLimit(), total);
  const partLimiter = createUploadLimiter(connectionLimit);
  const tracker = createUploadTracker(files, totalBytes);
  const fixedFolderId = state.folderId ? Number(state.folderId) : null;
  const fixedFolderKey = fixedFolderId ? state.crypto.folderKeys.get(fixedFolderId) : null;
  let completed = 0;
  let cancelled = false;
  panel.hidden = false;
  panel.classList.remove("upload-complete", "upload-error");
  $("#upload-heading").textContent = "アップロード中";
  $("#upload-status").textContent = `0 / ${total}件完了`;
  $("#upload-progress").style.width = "0%";
  $("#upload-speed").textContent = "";
  renderTransferFailures("#upload-failure-summary", "#upload-failed-list", []);
  $("#upload-cancel").hidden = false;
  $("#upload-cancel").disabled = false;
  try {
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
        try {
          const destination = destinations?.get(file);
          const destinationFolderId = destination?.folderId ?? fixedFolderId;
          const destinationFolderKey = destination?.folderKey ?? fixedFolderKey;
          await uploadOne(file, index + 1, total, destinationFolderId, destinationFolderKey, state.uploadAbort.signal, partLimiter, tracker);
          completed++;
          tracker.finish(file, completed);
        } catch (error) {
          if (error.name === "AbortError") return;
          tracker.defer(file);
          deferred.push({ error, file, index });
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
        const { file, index } = item;
        const destination = destinations?.get(file);
        const destinationFolderId = destination?.folderId ?? fixedFolderId;
        const destinationFolderKey = destination?.folderKey ?? fixedFolderKey;
        try {
          await uploadOne(file, index + 1, total, destinationFolderId, destinationFolderKey, state.uploadAbort.signal, partLimiter, tracker);
          completed++;
          tracker.finish(file, completed);
        } catch (error) {
          if (error.name === "AbortError") {
            cancelled = true;
            break;
          }
          tracker.defer(file);
          finalFailures.push({ file, error });
        }
      }
    }
    if (cancelled) {
      $("#upload-heading").textContent = "アップロードを停止しました";
      $("#upload-status").textContent = `${completed} / ${total}件完了`;
      $("#upload-file-progress").textContent = "未完了分は保存されていません";
      setNotice(`アップロードを停止しました。完了済みの${completed}件は保存されています。`);
    } else if (finalFailures.length) {
      panel.classList.add("upload-error");
      $("#upload-heading").textContent = "一部のアップロードに失敗しました";
      $("#upload-status").textContent = `${completed} / ${total}件完了`;
      $("#upload-file-progress").textContent = `${finalFailures.length}件エラー`;
      renderTransferFailures("#upload-failure-summary", "#upload-failed-list", finalFailures);
      setNotice(`${completed}件を保存しました。保存できなかったデータを一覧に表示しています。`, true);
    } else {
      panel.classList.add("upload-complete");
      $("#upload-heading").textContent = "アップロード完了";
      $("#upload-file-progress").textContent = "保存完了";
      await new Promise((resolve) => setTimeout(resolve, 900));
      panel.hidden = true;
    }
  } finally {
    state.uploading = false;
    state.uploadAbort = null;
    $("#upload-cancel").hidden = true;
    $("#upload-cancel").disabled = false;
    syncAvailableActions();
  }
  await Promise.all([loadItems(), loadUsage()]);
}

async function uploadOne(file, index, total, destinationFolderId, destinationFolderKey, signal, partLimiter, tracker) {
  throwIfUploadCancelled(signal);
  if (isBlockedClientFile(file)) throw new Error("安全上、このファイル形式は保存できません。");
  if (!globalThis.TCloudSafety) throw new Error("安全性確認機能を読み込めません。ページを再読み込みしてください。");
  await TCloudSafety.inspect(file);
  throwIfUploadCancelled(signal);
  const folderId = Number(destinationFolderId);
  const folderKey = destinationFolderKey || state.crypto.folderKeys.get(folderId);
  if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
  const mediaKind = detectClientKind(file.type || "application/octet-stream", file.name);
  const thumbnailPromise = makeThumbnail(file);
  const encrypted = await TRoomCrypto.createFilePackage(file, folderKey, mediaKind);
  throwIfUploadCancelled(signal);
  let init = null;
  let uploadCompleted = false;
  tracker.start(file, index, total);
  try {
    init = await api("/uploads", {
      method: "POST",
      body: JSON.stringify({ ...encrypted.payload, folderId }),
      signal
    });
    const chunkCount = Math.ceil(file.size / init.chunkSize);
    const parts = new Array(chunkCount);
    let nextPartNumber = 1;
    let uploadedBytes = 0;
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
          return uploadPartWithRetry(`/uploads/${init.id}/parts/${partNumber}`, encryptedChunk, signal);
        });
        uploadedBytes += end - offset;
        tracker.progress(file, end - offset, uploadedBytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(connectionLimitForFile(partLimiter.limit, total), chunkCount) }, uploadWorker));
    throwIfUploadCancelled(signal);
    tracker.phase(file, "保存処理中…");
    await api(`/uploads/${init.id}/complete`, { method: "POST", body: JSON.stringify({ parts }), signal });
    uploadCompleted = true;
    if (signal?.aborted) return;
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
  const uploadedByFile = new Map(files.map((file) => [file, 0]));
  const refresh = () => {
    const uploadedBytes = [...uploadedByFile.values()].reduce((sum, value) => sum + value, 0);
    const elapsedSeconds = Math.max(.25, (performance.now() - startedAt) / 1000);
    const percent = totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 100;
    const mbps = (uploadedBytes * 8) / elapsedSeconds / 1_000_000;
    $("#upload-progress").style.width = `${percent}%`;
    $("#upload-file-progress").textContent = `${percent}%`;
    $("#upload-speed").textContent = uploadedBytes ? `${mbps.toFixed(mbps >= 10 ? 1 : 2)} Mbps` : "";
    const names = [...active.keys()].map((file) => file.name);
    $("#upload-file-name").textContent = names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : (names[0] || "");
  };
  return {
    start(file) { active.set(file, 0); refresh(); },
    progress(file, _delta, fileBytes) { uploadedByFile.set(file, fileBytes); active.set(file, fileBytes); refresh(); },
    phase(file, label) { if (active.has(file)) $("#upload-file-progress").textContent = label; },
    finish(file, completed) {
      uploadedByFile.set(file, file.size);
      active.delete(file);
      $("#upload-status").textContent = `${completed} / ${files.length}件完了`;
      refresh();
    },
    defer(file) {
      uploadedByFile.set(file, 0);
      active.delete(file);
      refresh();
    }
  };
}

async function uploadPartWithRetry(path, body, signal) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await api(path, { method: "PUT", body, rawBody: true, signal });
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === maxAttempts) throw error;
      await uploadRetryDelay(400 * (2 ** (attempt - 1)) + Math.random() * 250, signal);
    }
  }
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
    const thumbnail = await captureVideoThumbnail(media.url, file);
    if (!thumbnail) return;
    const encryptedThumbnail = await TRoomCrypto.encryptThumbnail(thumbnail, file.fileKey);
    await api(`/files/${file.id}/thumbnail`, { method: "PUT", body: encryptedThumbnail, rawBody: true });
    file.hasThumbnail = true;
    showGeneratedThumbnail(file, thumbnail);
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
    const password = state.folderId ? "" : $("#folder-password").value;
    const encrypted = await TRoomCrypto.createFolderPackage($("#folder-name").value, password, state.crypto.publicKey, parentKey);
    const result = await api("/folders", { method: "POST", body: JSON.stringify({ ...encrypted.payload, name: encrypted.name, parentId: state.folderId }) });
    state.crypto.folderKeys.set(result.id, encrypted.folderKey);
    $("#folder-name").value = "";
    $("#folder-password").value = "";
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
    folder.isUnlocked = true;
    $("#unlock-dialog").close();
    await navigateToFolder(id, folder.name);
  } catch (error) {
    $("#unlock-error").textContent = error.message;
  }
}

async function openPreview(file, options = {}) {
  const { pushHistory = true } = options;
  const dialog = $("#preview-dialog");
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
  $("#preview-size").textContent = formatBytes(file.sizeBytes);
  $("#preview-date").textContent = formatDate(file.createdAt);
  $("#download-link").href = Number(file.cryptoVersion) === 1 ? "#" : `${API}/files/${file.id}/download`;
  $("#edit-file-button").hidden = !canRenameFile(file);
  $("#delete-file-button").hidden = !state.session.canDelete && !state.session.canTrashUnlockedFiles;
  $("#delete-file-button").textContent = state.session.canDelete ? "ゴミ箱へ" : "削除";
  const stage = $("#preview-stage");
  stage.innerHTML = "";
  syncPreviewNavigation(file);
  let url = `${API}/files/${file.id}/view`;
  if (Number(file.cryptoVersion) === 1) {
    if (!file.fileKey) {
      stage.innerHTML = `<div class="preview-fallback"><p>暗号化鍵を解除できないため表示できません。</p></div>`;
      if (!dialog.open) dialog.showModal();
      return;
    }
    stage.innerHTML = `<div class="preview-loading"><p>暗号を復号して再生準備をしています…</p></div>`;
    if (!dialog.open) dialog.showModal();
    try {
      const streaming = file.mediaKind === "video" || file.mediaKind === "audio" || Number(file.sizeBytes) > 128 * 1024 * 1024;
      if (streaming) {
        const media = await TCloudMedia.registerMedia(file, file.fileKey, `${API}/files/${file.id}/view`);
        state.previewMediaToken = media.token;
        url = media.url;
      } else {
        const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/view`);
        state.previewUrl = URL.createObjectURL(blob);
        url = state.previewUrl;
      }
    } catch (error) {
      stage.innerHTML = `<div class="preview-fallback"><p>${escapeHtml(error.message)}</p></div>`;
      return;
    }
  }
  if (file.mediaKind === "image") {
    renderPreviewImage(stage, file, url);
  } else if (file.mediaKind === "video") {
    renderVideoPlayer(stage, file, url);
  } else if (file.mediaKind === "audio") {
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = url; stage.replaceChildren(audio);
  } else if (file.mimeType === "application/pdf") {
    const frame = document.createElement("iframe"); frame.title = file.name; frame.src = url; stage.replaceChildren(frame);
  } else {
    stage.innerHTML = `<div class="preview-fallback"><p>この形式はブラウザ内プレビューに対応していません。</p><p>ダウンロードしてご確認ください。</p></div>`;
  }
  if (!dialog.open) dialog.showModal();
}

function renderPreviewImage(stage, file, url) {
  const image = new Image();
  image.alt = file.name;
  image.addEventListener("load", () => {
    if (Number(state.previewFileId) === Number(file.id) && $("#preview-dialog").open) stage.replaceChildren(image);
  }, { once: true });
  image.addEventListener("error", () => {
    if (Number(state.previewFileId) === Number(file.id) && $("#preview-dialog").open) {
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

async function togglePreviewFullscreen() {
  const stage = $("#preview-stage-wrap");
  const video = stage.querySelector("video");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (stage.requestFullscreen) await stage.requestFullscreen();
    else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
  } catch (error) { setNotice(`全画面表示を開始できませんでした：${error.message}`, true); }
}

function syncPreviewFullscreenButton() {
  const button = $("#preview-fullscreen");
  const active = Boolean(document.fullscreenElement);
  button.setAttribute("aria-label", active ? "全画面表示を終了" : "全画面で表示");
  const label = button.querySelector("span");
  if (label) label.textContent = active ? "戻す" : "全画面";
}

function handlePreviewDoubleClick(event) {
  const video = $("#preview-stage video");
  if (!video) return;
  const bounds = $("#preview-stage").getBoundingClientRect();
  const forward = event.clientX >= bounds.left + bounds.width / 2;
  video.currentTime = Math.max(0, video.currentTime + (forward ? 10 : -10));
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
  clearPreviewUrl();
  state.previewFileId = null;
  state.previewTouchStart = null;
  if (state.previewHistoryActive && !state.handlingPopState) {
    state.previewHistoryActive = false;
    history.back();
  }
}

function clearPreviewUrl() {
  if (state.previewPlayer) {
    try { state.previewPlayer.destroy(); } catch {}
    state.previewPlayer = null;
  }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = "";
  if (state.previewMediaToken) TCloudMedia.releaseMedia(state.previewMediaToken);
  state.previewMediaToken = "";
}

function renderVideoPlayer(stage, file, url) {
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  const buffering = document.createElement("div");
  buffering.className = "player-buffering";
  buffering.textContent = "再生準備中…";
  stage.replaceChildren(video, buffering);
  video.addEventListener("canplay", () => buffering.remove(), { once: true });
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
      if (stage.querySelector(".player-error")) return;
      buffering.remove();
      const message = document.createElement("p");
      message.className = "player-error";
      message.textContent = "このFLV・MPEG-TS動画の映像または音声方式には対応していません。元の画質のままダウンロードしてご確認ください。";
      stage.append(message);
      try { player.unload(); } catch {}
    });
    player.attachMediaElement(video);
    state.previewPlayer = player;
    player.load();
    return;
  }
  video.src = url;
  video.addEventListener("error", () => {
    if (!video.error) return;
    buffering.remove();
    const message = document.createElement("p");
    message.className = "player-error";
    message.textContent = "この動画の映像・音声方式はブラウザで再生できません。元の画質のままダウンロードしてご確認ください。";
    stage.append(message);
  }, { once: true });
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
      const metadata = { name, mimeType: file.mimeType, mediaKind: file.mediaKind };
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
    await loadItems();
  } catch (error) { $("#edit-error").textContent = error.message; }
}

async function deleteSelectedFile() {
  const file = state.selected;
  if (!file) return;
  const message = state.session?.canDelete ? `「${file.name}」をゴミ箱へ移動しますか？` : "本当に削除しますか？";
  const confirmed = state.session?.canDelete ? confirm(message) : await confirmSubadminDeletion(message);
  if (!confirmed) return;
  try {
    await api(`/files/${file.id}`, { method: "DELETE", body: "{}" });
    $("#preview-dialog").close();
    setNotice(state.session?.canDelete ? "ゴミ箱へ移動しました。" : "削除しました。");
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

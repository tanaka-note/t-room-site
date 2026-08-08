const API = "/cloud/api";
const state = {
  session: null,
  folderId: null,
  kind: "",
  view: "all",
  sort: "newest",
  query: "",
  files: [],
  folders: [],
  history: [],
  requests: [],
  shares: [],
  selected: null,
  selectedFolder: null,
  shareTarget: null,
  listMode: false,
  selectedFiles: new Map(),
  selecting: false,
  downloadAbort: null,
  wakeLock: null,
  downloadActive: false,
  previewUrl: "",
  previewMediaToken: "",
  previewPlayer: null,
  crypto: { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  try {
    const session = await api("/session");
    if (session.authenticated) await enterApp(session);
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
  $("#logout-button").addEventListener("click", logout);
  $("#mobile-logout-button").addEventListener("click", logout);
  $("#vault-logout-button").addEventListener("click", logout);
  $("#mobile-account-button").addEventListener("click", () => $("#account-dialog").showModal());
  $("#upload-button").addEventListener("click", openAddAction);
  $("#mobile-add-button").addEventListener("click", openAddAction);
  $("#file-input").addEventListener("change", (event) => uploadFiles([...event.target.files]));
  $("#new-folder-button").addEventListener("click", openFolderDialog);
  $("#mobile-upload-action").addEventListener("click", () => {
    $("#add-dialog").close();
    $("#file-input").click();
  });
  $("#mobile-folder-action").addEventListener("click", () => {
    $("#add-dialog").close();
    openFolderDialog();
  });
  $("#folder-form").addEventListener("submit", createFolder);
  $("#unlock-form").addEventListener("submit", unlockFolder);
  $("#folder-settings-form").addEventListener("submit", saveFolderSettings);
  $("#folder-password-action").addEventListener("change", toggleFolderPasswordInput);
  $("#delete-folder-button").addEventListener("click", deleteSelectedFolder);
  $("#edit-form").addEventListener("submit", saveFile);
  $("#edit-file-button").addEventListener("click", openEditDialog);
  $("#delete-file-button").addEventListener("click", deleteSelectedFile);
  $("#request-delete-file-button").addEventListener("click", requestSelectedFileDeletion);
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
  $("#download-link").addEventListener("click", (event) => {
    if (Number(state.selected?.cryptoVersion) !== 1) return;
    event.preventDefault();
    state.selectedFiles = new Map([[state.selected.id, state.selected]]);
    startSelectedDownloads();
  });
  $("#preview-dialog").addEventListener("close", clearPreviewUrl);
  $("#search-input").addEventListener("input", debounce((event) => { state.query = event.target.value.trim(); loadItems(); }, 250));
  $("#sort-select").addEventListener("change", (event) => { state.sort = event.target.value; loadItems(); });
  $("#display-toggle").addEventListener("click", () => { state.listMode = !state.listMode; renderItems(); });
  $("#selection-clear").addEventListener("click", clearFileSelection);
  $("#selection-download").addEventListener("click", startSelectedDownloads);
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

function openAddAction() {
  if (matchMedia("(max-width: 900px)").matches) {
    $("#add-dialog").showModal();
  } else {
    $("#file-input").click();
  }
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
    const password = $("#login-password").value;
    const mode = await api("/auth-mode");
    const credentials = await TRoomCrypto.deriveAccountCredentials(password);
    const loginBody = mode.mode === "proof"
      ? { loginId: $("#login-id").value, authProof: credentials.authProof }
      : { loginId: $("#login-id").value, password };
    const session = await api("/login", {
      method: "POST",
      body: JSON.stringify(loginBody)
    });
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
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#account-name").textContent = session.accountName;
  const permissionText = session.role === "admin" ? "すべての操作が可能" : "閲覧・アップロード（編集・削除不可）";
  $("#account-permission").textContent = permissionText;
  $("#mobile-account-name").textContent = session.accountName;
  $("#mobile-account-permission").textContent = permissionText;
  $("#edit-file-button").hidden = !session.canEditFiles;
  $("#request-delete-file-button").hidden = !session.canRequestDelete;
  $("#delete-file-button").hidden = !session.canDelete;
  $$('[data-view="trash"]').forEach((button) => { button.hidden = !session.canDelete; });
  $$('[data-view="history"]').forEach((button) => { button.hidden = !session.canViewHistory; });
  $$('[data-view="requests"]').forEach((button) => { button.hidden = !session.canReviewDeletion; });
  $$('[data-view="shares"]').forEach((button) => { button.hidden = session.role !== "admin"; });
  $("#share-file-button").hidden = session.role !== "admin";
  $("#share-folder-button").hidden = session.role !== "admin";
  syncAvailableActions();
  loadUsage();
  if (session.canReviewDeletion) loadDeletionRequestCount();
  await prepareCryptoSession(password, accountKey);
  await loadItems();
}

async function logout() {
  state.crypto = { config: null, accountKey: null, adminPrivateKey: null, publicKey: null, folderKeys: new Map(), fileEncryptionReady: false };
  await api("/logout", { method: "POST", body: "{}" });
  location.reload();
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
      else if (password) state.crypto.accountKey = await TRoomCrypto.deriveAccountKey(password);
      setCryptoStatus("暗号化鍵：フォルダ単位", true);
      return;
    }
    if (!password) {
      setCryptoStatus("暗号化鍵：ロック中", false);
      openVaultDialog("unlock");
      return;
    }
    const resolvedAccountKey = accountKey || await TRoomCrypto.deriveAccountKey(password);
    const privateKey = await TRoomCrypto.unlockAdminPrivateKey(resolvedAccountKey, config);
    state.crypto.accountKey = resolvedAccountKey;
    state.crypto.adminPrivateKey = privateKey;
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
    const accountKey = await TRoomCrypto.deriveAccountKey($("#vault-password").value);
    if (mode === "setup") {
      const vault = await TRoomCrypto.createVault(accountKey);
      await api("/crypto-setup", { method: "POST", body: JSON.stringify(vault.payload) });
      state.crypto.config = await api("/crypto-config");
      state.crypto.accountKey = accountKey;
      state.crypto.adminPrivateKey = vault.privateKey;
      state.crypto.publicKey = await crypto.subtle.importKey("jwk", vault.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      state.crypto.fileEncryptionReady = true;
      syncAvailableActions();
      $("#vault-dialog").close();
      showRecoveryCode(vault.recoveryCode);
      setCryptoStatus("暗号化鍵：解除済み", true);
      setNotice("端末側暗号化の初期設定が完了しました。復旧鍵を安全に保管してください。");
      await loadItems();
    } else {
      const privateKey = await TRoomCrypto.unlockAdminPrivateKey(accountKey, state.crypto.config);
      state.crypto.accountKey = accountKey;
      state.crypto.adminPrivateKey = privateKey;
      $("#vault-dialog").close();
      setCryptoStatus("暗号化鍵：解除済み", true);
      setNotice("暗号化鍵を解除しました。");
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
    state.folderId = null;
    state.kind = "";
    clearSearch();
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
  $$("[data-view], [data-kind]").forEach((item) => item.classList.toggle("active", item === button || (item.dataset.view && item.dataset.view === state.view && state.view !== "all")));
  syncAvailableActions();
  loadItems();
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
  $("#upload-button").hidden = inTrash || inHistory || inRequests || inShares || !insideFolder || !state.session?.canUpload;
  $("#upload-button").disabled = !state.crypto.fileEncryptionReady;
  $("#mobile-add-button").hidden = inTrash || inHistory || inRequests || inShares;
  $("#mobile-upload-action").hidden = !insideFolder || !state.session?.canUpload;
  $("#mobile-upload-action").disabled = !state.crypto.fileEncryptionReady;
  $("#toolbar").hidden = inHistory || inRequests || inShares;
  $("#search-input").placeholder = insideFolder ? "ファイル名を検索" : "フォルダ名を検索";
  $$('[data-kind]').forEach((button) => { button.disabled = !insideFolder || inTrash || inHistory || inRequests || inShares; });
}

async function loadItems() {
  clearFileSelection(false);
  setNotice("");
  try {
    if (state.view === "trash") {
      const data = await api("/trash");
      state.folders = [];
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
      const params = new URLSearchParams({ sort: state.sort });
      if (state.folderId) params.set("folderId", state.folderId);
      if (state.kind) params.set("kind", state.kind);
      if (state.query) params.set("q", state.query);
      const data = await api(`/items?${params}`);
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
  for (const folder of state.folders) grid.append(folderCard(folder));
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
  $("#display-toggle").textContent = state.listMode ? "▤" : "▦";
}

function folderCard(folder) {
  const card = document.createElement("article");
  card.className = "folder-card";
  const button = document.createElement("button");
  button.className = "folder-open-button";
  button.type = "button";
  const inheritsProtection = Boolean(folder.parentId && !folder.isProtected);
  const lock = folder.adminAccess ? " · 管理者アクセス" : inheritsProtection ? " · 親の保護を継承" : folder.isProtected ? (folder.isUnlocked ? " · 解除済み" : " · ロック") : "";
  button.innerHTML = `<span class="folder-icon">${folder.isProtected || inheritsProtection ? "▣" : "▰"}</span><span><strong>${escapeHtml(folder.name)}</strong><small>${lock}</small></span>`;
  button.addEventListener("click", () => openFolder(folder));
  card.append(button);
  if (state.session.canEditFolders) {
    const settings = document.createElement("button");
    settings.className = "folder-settings-button";
    settings.type = "button";
    settings.setAttribute("aria-label", `${folder.name}の設定`);
    settings.textContent = "⋯";
    settings.addEventListener("click", () => openFolderSettings(folder));
    card.append(settings);
  }
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
      if (key) {
        try {
          folder.name = await TRoomCrypto.decryptFolderName(folder, key);
          folder.isUnlocked = true;
        } catch {
          folder.name = "復号できないフォルダ";
          folder.isUnlocked = false;
        }
      } else {
        folder.name = "保護フォルダ";
        folder.isUnlocked = false;
      }
    }
    hydrated.push(folder);
  }
  let result = hydrated;
  if (state.query) result = result.filter((folder) => folder.name.toLocaleLowerCase("ja").includes(state.query.toLocaleLowerCase("ja")));
  if (state.sort === "name") result.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  else if (state.sort === "oldest") result.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  else result.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
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
      } else if (share.targetType === "file" && share.file) {
        const [file] = await hydrateFileRecords([share.file]);
        share.file = file;
        share.targetName = file.name;
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
  const type = share.targetType === "folder" ? "フォルダ" : "ファイル";
  card.innerHTML = `
    <span class="share-kind">${share.targetType === "folder" ? "▰" : kindSymbol(share.file?.mediaKind)}</span>
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
    else targetKey = target.fileKey;
    if (!targetKey) throw new Error("共有対象の暗号化鍵を解除できません。");
    state.shareTarget = { type, id: Number(target.id), name: target.name, targetKey };
    $("#share-target").textContent = `共有対象：${target.name}（${type === "folder" ? "フォルダ" : "ファイル"}）`;
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
    const result = await api("/shares", {
      method: "POST",
      body: JSON.stringify({
        token,
        targetType: target.type,
        targetId: target.id,
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
  $("#folder-password-settings-row").hidden = inheritsProtection;
  $("#folder-inherited-settings-note").hidden = !inheritsProtection;
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
  const passwordAction = state.selectedFolder?.parentId && !state.selectedFolder?.isProtected ? "keep" : $("#folder-password-action").value;
  $("#folder-settings-error").textContent = "";
  try {
    const folder = state.selectedFolder;
    const folderKey = state.crypto.folderKeys.get(id) || (state.session.role === "admin" ? await ensureAdminFolderKey(folder) : null);
    if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
    const namePackage = await TRoomCrypto.encryptFolderName($("#folder-settings-name").value, folderKey);
    const passwordPackage = passwordAction === "replace"
      ? await TRoomCrypto.rewrapFolderPassword(folderKey, $("#folder-new-password").value)
      : {};
    await api(`/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ cryptoVersion: 1, encryptedName: namePackage.encryptedName, nameIv: namePackage.nameIv, passwordAction, ...passwordPackage })
    });
    folder.name = namePackage.name;
    folder.encryptedName = namePackage.encryptedName;
    folder.nameIv = namePackage.nameIv;
    $("#folder-settings-dialog").close();
    setNotice("フォルダ設定を更新しました。");
    await loadItems();
  } catch (error) { $("#folder-settings-error").textContent = error.message; }
}

async function deleteSelectedFolder() {
  const folder = state.selectedFolder;
  if (!folder || !state.session.canDelete || !confirm(`「${folder.name}」を削除しますか？空のフォルダだけ削除できます。`)) return;
  try {
    await api(`/folders/${folder.id}`, { method: "DELETE", body: "{}" });
    $("#folder-settings-dialog").close();
    setNotice("フォルダを削除しました。");
    await loadItems();
  } catch (error) { $("#folder-settings-error").textContent = error.message; }
}

async function openFolder(folder) {
  if (Number(folder.cryptoVersion) === 1 && state.session.role === "admin" && !state.crypto.folderKeys.has(folder.id)) {
    try {
      const key = await ensureAdminFolderKey(folder);
      folder.name = await TRoomCrypto.decryptFolderName(folder, key);
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
  state.folderId = folder.id;
  state.kind = "";
  state.view = "all";
  clearSearch();
  $("#view-title").textContent = folder.name;
  syncAvailableActions();
  loadItems();
}

function fileCard(file) {
  const card = document.createElement("article");
  card.className = "file-card";
  card.dataset.fileId = String(file.id);
  const button = document.createElement("button");
  button.type = "button";
  const thumbnail = file.hasThumbnail && Number(file.cryptoVersion) !== 1
    ? `<img src="${API}/files/${file.id}/thumbnail" alt="" loading="lazy">`
    : `<span class="media-symbol">${kindSymbol(file.mediaKind)}</span>`;
  button.innerHTML = `
    <div class="thumb">${thumbnail}${file.deletionPending ? '<span class="pending-label">削除申請中</span>' : ""}</div>
    <div class="file-copy"><strong>${escapeHtml(file.name)}</strong><span class="file-meta"><span>${formatBytes(file.sizeBytes)}</span><span>${formatDate(file.createdAt || file.deletedAt)}</span></span></div>`;
  button.addEventListener("click", (event) => {
    if (card.dataset.longPressed === "true") {
      card.dataset.longPressed = "false";
      return;
    }
    if (state.selectedFiles.size || event.ctrlKey || event.metaKey || event.shiftKey) {
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
  if (state.sort === "name") result.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  else if (state.sort === "oldest") result.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  else if (state.sort === "size") result.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
  else result.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
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
      const folderKey = state.crypto.folderKeys.get(Number(item.folderId));
      if (folderKey && item.folderEncryptedName) {
        try {
          item.folderName = await TRoomCrypto.decryptFolderName({
            cryptoVersion: item.folderCryptoVersion,
            encryptedName: item.folderEncryptedName,
            nameIv: item.folderNameIv
          }, folderKey);
        } catch {
          item.folderName = "復号できないフォルダ";
        }
      } else {
        item.folderName = "保護フォルダ";
      }
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
    }, state.selectedFiles.size ? 80 : 380);
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

function selectFile(file, card) {
  if (file.trashed || state.selectedFiles.has(file.id)) return;
  state.selectedFiles.set(file.id, file);
  card.classList.add("selected", "selection-pass");
  syncSelectionBar();
}

function toggleFileSelection(file, card) {
  if (file.trashed) return;
  if (state.selectedFiles.has(file.id)) {
    state.selectedFiles.delete(file.id);
    card.classList.remove("selected", "selection-pass");
  } else {
    selectFile(file, card);
  }
  syncSelectionBar();
}

function clearFileSelection(update = true) {
  state.selectedFiles.clear();
  state.selecting = false;
  $$(".file-card.selected, .file-card.selection-pass").forEach((card) => card.classList.remove("selected", "selection-pass"));
  if (update) syncSelectionBar();
  else $("#selection-bar").hidden = true;
}

function syncSelectionBar() {
  const count = state.selectedFiles.size;
  $("#selection-count").textContent = `${count.toLocaleString("ja-JP")}件を選択中`;
  $("#selection-bar").hidden = count === 0;
  $("#selection-download").disabled = count === 0;
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
  state.downloadActive = true;
  state.downloadAbort = new AbortController();
  renderDownloadQueue(files);
  $("#download-dialog").showModal();
  $("#download-cancel").hidden = false;
  $("#download-close").disabled = true;
  if ($("#keep-screen-awake").checked) await requestDownloadWakeLock();
  let completed = 0;
  let activeFile = null;
  try {
    for (const file of files) {
      activeFile = file;
      if (state.downloadAbort.signal.aborted) throw new DOMException("中止しました", "AbortError");
      $("#download-current").textContent = file.name;
      updateDownloadQueueItem(file.id, "処理中", "");
      await recordDownloadEvent(file.id, "download_started");
      await downloadFile(file, state.downloadAbort.signal, targets.get(file.id) || null);
      await recordDownloadEvent(file.id, "download_completed");
      completed++;
      updateDownloadQueueItem(file.id, "完了", "done");
      updateDownloadProgress(completed, files.length);
    }
    $("#download-summary").textContent = `${completed}件の保存が完了しました`;
    $("#download-current").textContent = "選択した保存先をご確認ください。";
  } catch (error) {
    if (activeFile) await recordDownloadEvent(activeFile.id, "download_failed", error.name === "AbortError" ? "cancelled" : error.message);
    if (error.name === "AbortError") {
      $("#download-summary").textContent = "ダウンロードを中止しました";
      $("#download-current").textContent = "未処理のファイルは保存されません。";
    } else {
      $("#download-summary").textContent = "一部のダウンロードに失敗しました";
      $("#download-current").textContent = error.message;
    }
  } finally {
    state.downloadActive = false;
    state.downloadAbort = null;
    await releaseDownloadWakeLock();
    $("#download-cancel").hidden = true;
    $("#download-close").disabled = false;
    clearFileSelection();
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
  $("#download-queue").innerHTML = files.map((file) => `<li data-download-id="${file.id}"><span>${escapeHtml(file.name)}</span><span>待機中</span></li>`).join("");
  $("#download-summary").textContent = `${files.length}件を準備しています`;
  $("#download-current").textContent = "";
  updateDownloadProgress(0, files.length);
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
  if (state.view === "trash") { nav.textContent = "削除されたファイルは30日後に完全削除されます。"; return; }
  if (state.view === "history") { nav.textContent = state.session?.role === "admin" ? "管理者・副管理者のアップロード／ダウンロード履歴です。" : "副管理者本人のアップロード／ダウンロード履歴です。"; return; }
  if (state.view === "requests") { nav.textContent = "承認するまでファイルは削除されず、通常どおり利用できます。"; return; }
  if (state.view === "shares") { nav.textContent = "共有URLの発行状況・期限・停止・利用履歴を管理できます。"; return; }
  nav.innerHTML = "";
  const home = document.createElement("button");
  home.type = "button";
  home.textContent = "Cloud Storage";
  home.addEventListener("click", () => {
    state.folderId = null;
    state.kind = "";
    state.view = "all";
    clearSearch();
    $("#view-title").textContent = "フォルダ";
    syncAvailableActions();
    loadItems();
  });
  nav.append(home);
  for (const item of items) {
    const span = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.name;
    button.addEventListener("click", () => {
      state.folderId = item.id;
      state.kind = "";
      state.view = "all";
      clearSearch();
      $("#view-title").textContent = item.name;
      syncAvailableActions();
      loadItems();
    });
    span.append(button);
    nav.append(span);
  }
}

async function uploadFiles(files) {
  if (!files.length || !state.session.canUpload) return;
  if (!state.crypto.fileEncryptionReady) {
    setNotice("暗号化の初期設定を完了してください。", true);
    return;
  }
  $("#file-input").value = "";
  for (const file of files) {
    try {
      await uploadOne(file);
    } catch (error) {
      setNotice(`${file.name}: ${error.message}`, true);
      break;
    }
  }
  $("#upload-panel").hidden = true;
  await Promise.all([loadItems(), loadUsage()]);
}

async function uploadOne(file) {
  if (isBlockedClientFile(file)) throw new Error("安全上、このファイル形式は保存できません。");
  if (!globalThis.TCloudSafety) throw new Error("安全性確認機能を読み込めません。ページを再読み込みしてください。");
  await TCloudSafety.inspect(file);
  const folderKey = state.crypto.folderKeys.get(Number(state.folderId));
  if (!folderKey) throw new Error("フォルダの暗号化鍵を解除してください。");
  const mediaKind = detectClientKind(file.type || "application/octet-stream", file.name);
  const encrypted = await TRoomCrypto.createFilePackage(file, folderKey, mediaKind);
  const init = await api("/uploads", {
    method: "POST",
    body: JSON.stringify({ ...encrypted.payload, folderId: state.folderId })
  });
  const panel = $("#upload-panel");
  panel.hidden = false;
  $("#upload-file-name").textContent = file.name;
  const parts = [];
  try {
    for (let offset = 0, partNumber = 1; offset < file.size; offset += init.chunkSize, partNumber++) {
      const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + init.chunkSize, file.size)).arrayBuffer());
      const encryptedChunk = await TRoomCrypto.encryptFileChunk(encrypted.fileKey, chunk, partNumber - 1);
      chunk.fill(0);
      const part = await api(`/uploads/${init.id}/parts/${partNumber}`, { method: "PUT", body: encryptedChunk, rawBody: true });
      parts.push(part);
      const progress = Math.min(100, Math.round(((offset + Math.min(init.chunkSize, file.size - offset)) / file.size) * 100));
      $("#upload-progress").style.width = `${progress}%`;
      $("#upload-status").textContent = `${progress}%`;
    }
    await api(`/uploads/${init.id}/complete`, { method: "POST", body: JSON.stringify({ parts }) });
    const thumbnail = await makeThumbnail(file);
    if (thumbnail) {
      const encryptedThumbnail = await TRoomCrypto.encryptThumbnail(thumbnail, encrypted.fileKey);
      await api(`/files/${init.id}/thumbnail`, { method: "PUT", body: encryptedThumbnail, rawBody: true });
    }
  } catch (error) {
    try { await api(`/uploads/${init.id}`, { method: "DELETE", body: "{}" }); } catch {}
    throw error;
  }
}

async function makeThumbnail(file) {
  if (!file.type.startsWith("image/")) return null;
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

async function createFolder(event) {
  event.preventDefault();
  try {
    if (!state.crypto.publicKey) throw new Error("暗号化の初期設定を完了してください。");
    const parentKey = state.folderId ? state.crypto.folderKeys.get(Number(state.folderId)) : null;
    if (state.folderId && !parentKey) throw new Error("親フォルダの暗号化鍵を解除してください。");
    const password = state.folderId ? "" : $("#folder-password").value;
    const encrypted = await TRoomCrypto.createFolderPackage($("#folder-name").value, password, state.crypto.publicKey, parentKey);
    const result = await api("/folders", { method: "POST", body: JSON.stringify({ ...encrypted.payload, parentId: state.folderId }) });
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
    folder.name = await TRoomCrypto.decryptFolderName(folder, unlocked.folderKey);
    folder.isUnlocked = true;
    $("#unlock-dialog").close();
    state.folderId = id;
    state.kind = "";
    state.view = "all";
    clearSearch();
    $("#view-title").textContent = folder.name;
    syncAvailableActions();
    await loadItems();
  } catch (error) {
    $("#unlock-error").textContent = error.message;
  }
}

async function openPreview(file) {
  state.selected = file;
  $("#preview-title").textContent = file.name;
  $("#preview-kind").textContent = kindLabel(file.mediaKind);
  $("#preview-size").textContent = formatBytes(file.sizeBytes);
  $("#preview-date").textContent = formatDate(file.createdAt);
  $("#download-link").href = Number(file.cryptoVersion) === 1 ? "#" : `${API}/files/${file.id}/download`;
  $("#edit-file-button").hidden = !state.session.canEditFiles;
  $("#request-delete-file-button").hidden = !state.session.canRequestDelete;
  $("#request-delete-file-button").disabled = Boolean(file.deletionPending);
  $("#request-delete-file-button").textContent = file.deletionPending ? "削除申請中" : "削除申請";
  $("#delete-file-button").hidden = !state.session.canDelete;
  const stage = $("#preview-stage");
  stage.innerHTML = "";
  let url = `${API}/files/${file.id}/view`;
  if (Number(file.cryptoVersion) === 1) {
    if (!file.fileKey) {
      stage.innerHTML = `<div class="preview-fallback"><p>暗号化鍵を解除できないため表示できません。</p></div>`;
      $("#preview-dialog").showModal();
      return;
    }
    stage.innerHTML = `<div class="preview-fallback"><p>専用プレイヤーを準備しています…</p></div>`;
    $("#preview-dialog").showModal();
    try {
      clearPreviewUrl();
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
    const image = new Image(); image.alt = file.name; image.src = url; stage.append(image);
  } else if (file.mediaKind === "video") {
    renderVideoPlayer(stage, file, url);
  } else if (file.mediaKind === "audio") {
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = url; stage.append(audio);
  } else if (file.mimeType === "application/pdf") {
    const frame = document.createElement("iframe"); frame.title = file.name; frame.src = url; stage.append(frame);
  } else {
    stage.innerHTML = `<div class="preview-fallback"><p>この形式はブラウザ内プレビューに対応していません。</p><p>ダウンロードしてご確認ください。</p></div>`;
  }
  if (!$("#preview-dialog").open) $("#preview-dialog").showModal();
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
  stage.replaceChildren(video);
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
    const message = document.createElement("p");
    message.className = "player-error";
    message.textContent = "この動画の映像・音声方式はブラウザで再生できません。元の画質のままダウンロードしてご確認ください。";
    stage.append(message);
  }, { once: true });
}

function openEditDialog() {
  const file = state.selected;
  if (!file) return;
  $("#edit-file-id").value = file.id;
  $("#edit-name").value = file.name;
  $("#preview-dialog").close();
  $("#edit-dialog").showModal();
}

async function saveFile(event) {
  event.preventDefault();
  const id = Number($("#edit-file-id").value);
  try {
    const file = state.selected;
    if (Number(file.cryptoVersion) === 1) {
      const metadata = { name: $("#edit-name").value.trim(), mimeType: file.mimeType, mediaKind: file.mediaKind };
      const encryptedMetadata = await TRoomCrypto.encryptFileMetadata(metadata, file.fileKey);
      await api(`/files/${id}`, { method: "PATCH", body: JSON.stringify(encryptedMetadata) });
      file.name = metadata.name;
      file.encryptedMetadata = encryptedMetadata.encryptedMetadata;
      file.metadataIv = encryptedMetadata.metadataIv;
    } else {
      await api(`/files/${id}`, { method: "PATCH", body: JSON.stringify({ name: $("#edit-name").value }) });
    }
    $("#edit-dialog").close();
    setNotice("ファイル情報を更新しました。");
    await loadItems();
  } catch (error) { setNotice(error.message, true); }
}

async function deleteSelectedFile() {
  const file = state.selected;
  if (!file || !confirm(`「${file.name}」をゴミ箱へ移動しますか？`)) return;
  try {
    await api(`/files/${file.id}`, { method: "DELETE", body: "{}" });
    $("#preview-dialog").close();
    setNotice("ゴミ箱へ移動しました。");
    await Promise.all([loadItems(), loadUsage()]);
  } catch (error) { setNotice(error.message, true); }
}

async function requestSelectedFileDeletion() {
  const file = state.selected;
  if (!file || !state.session.canRequestDelete || file.deletionPending) return;
  if (!confirm(`「${file.name}」の削除を管理者へ申請しますか？承認までは通常どおり利用できます。`)) return;
  try {
    await api(`/files/${file.id}/deletion-request`, { method: "POST", body: "{}" });
    $("#preview-dialog").close();
    setNotice("削除申請を送信しました。管理者の承認まではファイルを利用できます。");
    await loadItems();
  } catch (error) { setNotice(error.message, true); }
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
  state.selected = file;
  $("#trash-file-name").textContent = file.name;
  $("#permanent-delete-button").hidden = !state.session.canDelete;
  $("#trash-dialog").showModal();
}

async function restoreSelectedFile() {
  const file = state.selected;
  if (!file) return;
  try {
    await api(`/files/${file.id}/restore`, { method: "POST", body: "{}" });
    $("#trash-dialog").close();
    setNotice("ファイルを元に戻しました。");
    await loadItems();
  } catch (error) { setNotice(error.message, true); }
}

async function permanentlyDeleteSelectedFile() {
  const file = state.selected;
  if (!file || !state.session.canDelete || !confirm("完全に削除すると元に戻せません。削除しますか？")) return;
  try {
    await api(`/files/${file.id}/permanent`, { method: "DELETE", body: "{}" });
    $("#trash-dialog").close();
    setNotice("完全に削除しました。");
    await Promise.all([loadItems(), loadUsage()]);
  } catch (error) { setNotice(error.message, true); }
}

async function loadUsage() {
  try {
    const usage = await api("/usage");
    $("#usage-text").textContent = formatBytes(usage.totalBytes);
    $("#file-count").textContent = `${usage.fileCount.toLocaleString("ja-JP")}ファイル`;
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
    throw new Error(data?.error || `通信に失敗しました（${response.status}）`);
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
  if (mime.startsWith("video/") || /\.(flv|mkv|mov|avi|webm|mpg|mpeg|mxf|gxf|lxf|3gp)$/i.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(m4a|mp3|wav|aac|flac|ogg)$/i.test(name)) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/i.test(name)) return "document";
  return "other";
}
function isBlockedClientFile(file) {
  return /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|reg|apk|app|dmg|pkg)$/i.test(file.name)
    || ["application/x-msdownload", "application/x-sh", "application/x-executable"].includes(file.type);
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

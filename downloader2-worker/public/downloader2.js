(() => {
  "use strict";

  const BASE = "/downloader2/api";
  const CHANNEL = "tlain-downloader2-v1";
  const byId = (id) => document.getElementById(id);
  const elements = Object.fromEntries([
    "message", "login-view", "passkey-login", "logout", "app-view", "extension-status", "companion-status",
    "capture-status", "pairing-panel", "pair-device", "detect-form", "source-url", "detect-button", "deep-capture",
    "candidates-view", "candidate-list", "candidate-count", "progress-view", "progress-label", "download-progress",
    "progress-detail", "cancel-download", "refresh-history", "history-list"
  ].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), byId(id)]));
  const pending = new Map();
  const candidates = new Map();
  let extensionReady = false;
  let activeDownloadId = "";

  document.addEventListener("DOMContentLoaded", initialize);
  window.addEventListener("message", receiveExtensionMessage);

  async function initialize() {
    bindEvents();
    announcePage();
    try {
      await api("/session");
      showApp();
      await connectLocalServices();
    } catch (error) {
      if (error.status === 401) showLogin();
      else showMessage(error.message);
    }
  }

  function bindEvents() {
    elements.passkeyLogin.addEventListener("click", login);
    elements.logout.addEventListener("click", logout);
    elements.pairDevice.addEventListener("click", pairDevice);
    elements.detectForm.addEventListener("submit", startCapture);
    elements.cancelDownload.addEventListener("click", cancelDownload);
    elements.refreshHistory.addEventListener("click", loadHistory);
  }

  function announcePage() {
    window.postMessage({ channel: CHANNEL, direction: "page-to-extension", type: "page.ready", requestId: requestId() }, location.origin);
  }

  async function login() {
    setBusy(elements.passkeyLogin, true, "本人確認中…");
    try {
      const authentication = await window.TRoomPasskeys.authenticate("downloader2");
      await api("/passkey/handoff", { method: "POST", body: { handoffToken: authentication.handoff.handoffToken } });
      showApp();
      await connectLocalServices();
    } catch (error) { showMessage(userMessage(error)); }
    finally { setBusy(elements.passkeyLogin, false, "端末のロック解除でログイン"); }
  }

  async function logout() {
    try { await api("/logout", { method: "POST", body: {} }); } catch { /* local view is cleared */ }
    candidates.clear();
    renderCandidates();
    showLogin();
  }

  async function connectLocalServices() {
    try {
      const extension = await extensionRequest("extension.ping", {}, 2000);
      extensionReady = true;
      updateStatus(elements.extensionStatus, extension.browser || "接続済み", true);
      const host = await extensionRequest("host.ping", {}, 4000);
      updateStatus(elements.companionStatus, host.paired ? "接続済み" : "ペアリング待ち", host.paired);
      elements.pairingPanel.hidden = host.paired === true;
      if (host.paired) await loadHistory();
    } catch (error) {
      updateStatus(elements.extensionStatus, extensionReady ? "接続済み" : "未接続", extensionReady);
      updateStatus(elements.companionStatus, "未接続", false);
      elements.pairingPanel.hidden = false;
      if (extensionReady) showMessage(error.message || "Windows Companionへ接続できませんでした。");
    }
  }

  async function pairDevice() {
    setBusy(elements.pairDevice, true, "ペアリング中…");
    try {
      const prepared = await extensionRequest("device.pair.prepare", {}, 5000);
      const challenge = await api("/pairing/challenge", { method: "POST", body: { deviceChallenge: prepared.deviceChallenge } });
      const result = await extensionRequest("device.pair", { pairingToken: challenge.token, expiresAt: challenge.expiresAt }, 8000);
      if (!result.paired) throw new Error("Companionとのペアリングを完了できませんでした。");
      updateStatus(elements.companionStatus, "接続済み", true);
      elements.pairingPanel.hidden = true;
      hideMessage();
      await loadHistory();
    } catch (error) { showMessage(error.message); }
    finally { setBusy(elements.pairDevice, false, "このPCをペアリング"); }
  }

  async function startCapture(event) {
    event.preventDefault();
    candidates.clear();
    renderCandidates();
    setBusy(elements.detectButton, true, "起動中…");
    try {
      const result = await extensionRequest("capture.start", { url: elements.sourceUrl.value.trim(), deep: elements.deepCapture.checked }, 10000);
      elements.captureStatus.textContent = result.deep ? "Deep Capture" : "通常検出";
      elements.candidatesView.hidden = false;
      hideMessage();
    } catch (error) { showMessage(error.message); }
    finally { setBusy(elements.detectButton, false, "動画を検出"); }
  }

  async function downloadCandidate(candidateId, button) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return;
    setBusy(button, true, "開始中…");
    try {
      const result = await extensionRequest("download.start", { candidate, title: document.title }, 10000);
      activeDownloadId = result.downloadId;
      elements.progressView.hidden = false;
      elements.progressLabel.textContent = "ローカル保存を開始しました";
      elements.downloadProgress.removeAttribute("value");
      hideMessage();
    } catch (error) { showMessage(error.message); setBusy(button, false, "取得する"); }
  }

  async function cancelDownload() {
    if (!activeDownloadId) return;
    setBusy(elements.cancelDownload, true, "中止中…");
    try { await extensionRequest("download.cancel", { downloadId: activeDownloadId }, 5000); }
    catch (error) { showMessage(error.message); }
    finally { setBusy(elements.cancelDownload, false, "中止する"); }
  }

  async function loadHistory() {
    try {
      const result = await extensionRequest("history.list", {}, 5000);
      renderHistory(result.items || []);
    } catch { elements.historyList.innerHTML = '<p class="empty">ローカル履歴を取得できませんでした。</p>'; }
  }

  function receiveExtensionMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== "extension-to-page") return;
    if (message.type === "extension.ready") {
      extensionReady = true;
      updateStatus(elements.extensionStatus, message.browser || "接続済み", true);
      return;
    }
    if (message.type === "capture.candidate" && message.candidate?.id) {
      candidates.set(message.candidate.id, message.candidate);
      renderCandidates();
      return;
    }
    if (message.type === "download.progress") return renderProgress(message);
    const callback = pending.get(message.requestId);
    if (!callback) return;
    pending.delete(message.requestId);
    clearTimeout(callback.timer);
    if (message.ok === false) callback.reject(new Error(message.error || "Extensionで処理を完了できませんでした。"));
    else callback.resolve(message.result || {});
  }

  function renderCandidates() {
    elements.candidateList.replaceChildren();
    const list = [...candidates.values()].sort((left, right) => (right.priority || 0) - (left.priority || 0));
    elements.candidateCount.textContent = `${list.length}件`;
    elements.candidatesView.hidden = list.length === 0;
    for (const item of list) {
      const card = document.createElement("article");
      card.className = "candidate-card";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.label || item.kind || "メディア";
      const details = document.createElement("small");
      details.textContent = [item.kind?.toUpperCase(), item.contentType, item.source === "debugger" ? "Deep Capture" : "通常検出"].filter(Boolean).join(" / ");
      const host = document.createElement("small");
      host.textContent = item.hostname || "";
      info.append(title, details, host);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "primary compact";
      button.textContent = item.drm ? "DRM非対応" : "取得する";
      button.disabled = Boolean(item.drm);
      button.addEventListener("click", () => downloadCandidate(item.id, button));
      card.append(info, button);
      elements.candidateList.append(card);
    }
  }

  function renderProgress(message) {
    if (activeDownloadId && message.downloadId !== activeDownloadId) return;
    activeDownloadId = message.downloadId || activeDownloadId;
    elements.progressView.hidden = false;
    elements.progressLabel.textContent = message.label || stageLabel(message.stage);
    if (Number.isFinite(message.percent)) elements.downloadProgress.value = Math.max(0, Math.min(100, message.percent));
    else elements.downloadProgress.removeAttribute("value");
    elements.progressDetail.textContent = message.detail || "";
    if (["completed", "failed", "cancelled"].includes(message.stage)) {
      if (message.stage === "completed") showMessage(`保存しました：${message.filename || "Downloadsフォルダ"}`, false);
      else showMessage(message.error || (message.stage === "cancelled" ? "保存を中止しました。" : "保存できませんでした。"));
      activeDownloadId = "";
      void loadHistory();
    }
  }

  function renderHistory(items) {
    elements.historyList.replaceChildren();
    if (!items.length) { elements.historyList.innerHTML = '<p class="empty">まだローカル処理はありません。</p>'; return; }
    for (const item of items.slice(0, 20)) {
      const row = document.createElement("article");
      row.className = "job-row";
      const title = document.createElement("strong");
      title.textContent = item.title || item.filename || "メディア";
      const detail = document.createElement("small");
      detail.textContent = [item.hostname, item.engine, item.status, sizeText(item.fileSize)].filter(Boolean).join(" / ");
      row.append(title, detail);
      elements.historyList.append(row);
    }
  }

  function extensionRequest(type, payload, timeout = 5000) {
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Extensionから応答がありません。")); }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, direction: "page-to-extension", type, requestId: id, payload }, location.origin);
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(`${BASE}${path}`, {
      method: options.method || "GET", credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(payload.error || "処理を完了できませんでした。"); error.status = response.status; throw error; }
    return payload;
  }

  function showLogin() { elements.loginView.hidden = false; elements.appView.hidden = true; elements.logout.hidden = true; }
  function showApp() { elements.loginView.hidden = true; elements.appView.hidden = false; elements.logout.hidden = false; hideMessage(); }
  function updateStatus(element, text, online) { element.textContent = text; element.dataset.state = online ? "online" : "offline"; }
  function setBusy(button, busy, text) { button.disabled = busy; button.textContent = text; }
  function showMessage(text, error = true) { elements.message.textContent = text; elements.message.dataset.kind = error ? "error" : "success"; elements.message.hidden = false; }
  function hideMessage() { elements.message.hidden = true; elements.message.textContent = ""; }
  function requestId() { return crypto.randomUUID(); }
  function userMessage(error) { return window.TRoomPasskeys?.userMessage?.(error) || error?.message || "本人確認を完了できませんでした。"; }
  function sizeText(value) { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes < 0) return ""; const units = ["B", "KB", "MB", "GB"]; let amount = bytes; let index = 0; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`; }
  function stageLabel(stage) { return ({ probing: "配信元を確認しています", downloading: "ローカルへ保存しています", validating: "メディアを検証しています", scanning: "Windows Defenderで検査しています", finalizing: "完成ファイルへ切り替えています", completed: "保存が完了しました", failed: "保存に失敗しました", cancelled: "保存を中止しました" })[stage] || "処理しています"; }
})();

(() => {
  "use strict";

  const BASE = "/downloader/api";
  const elements = Object.fromEntries([
    "message", "login-view", "passkey-login", "logout", "app-view", "analyze-form", "source-url",
    "analyze-button", "analysis-view", "analysis-title", "analysis-method", "source-details",
    "analysis-warning", "download-form", "media-list", "rights-confirmed", "download-button",
    "progress-view", "progress-label", "ready-view", "file-details", "file-download", "expiry-note",
    "job-list", "refresh-jobs"
  ].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));
  let currentJob = null;
  let pollTimer = 0;

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    bindEvents();
    try {
      await api("/session");
      showApp();
      await loadJobs();
    } catch (error) {
      if (error.status === 401) showLogin();
      else showMessage(error.message);
    }
  }

  function bindEvents() {
    elements.passkeyLogin.addEventListener("click", login);
    elements.logout.addEventListener("click", logout);
    elements.analyzeForm.addEventListener("submit", analyze);
    elements.downloadForm.addEventListener("submit", requestDownload);
    elements.refreshJobs.addEventListener("click", loadJobs);
  }

  async function login() {
    setBusy(elements.passkeyLogin, true, "本人確認中…");
    try {
      const authentication = await window.TRoomPasskeys.authenticate("downloader");
      await api("/passkey/handoff", { method: "POST", body: { handoffToken: authentication.handoff.handoffToken } });
      showApp();
      await loadJobs();
    } catch (error) {
      showMessage(userMessage(error));
    } finally {
      setBusy(elements.passkeyLogin, false, "端末のロック解除でログイン");
    }
  }

  async function logout() {
    try { await api("/logout", { method: "POST", body: {} }); } catch { /* local state is cleared either way */ }
    clearTimeout(pollTimer);
    currentJob = null;
    showLogin();
  }

  async function analyze(event) {
    event.preventDefault();
    clearViews();
    hideMessage();
    const url = elements.sourceUrl.value.trim();
    setBusy(elements.analyzeButton, true, "解析中…");
    try {
      const result = await api("/analyze", { method: "POST", body: { url, clientRequestId: requestId() } });
      currentJob = result.job;
      renderAnalysis(result.job);
      await loadJobs();
    } catch (error) {
      showMessage(error.message);
    } finally {
      setBusy(elements.analyzeButton, false, "解析");
    }
  }

  async function requestDownload(event) {
    event.preventDefault();
    const mediaId = elements.mediaList.querySelector("input[name='media']:checked")?.value;
    if (!currentJob || !mediaId) return showMessage("取得するメディアを選択してください。");
    setBusy(elements.downloadButton, true, "取得準備中…");
    try {
      const result = await api(`/jobs/${encodeURIComponent(currentJob.id)}/download`, {
        method: "POST",
        body: { url: elements.sourceUrl.value.trim(), mediaId, rightsConfirmed: elements.rightsConfirmed.checked }
      });
      currentJob = result.job;
      elements.analysisView.hidden = true;
      elements.progressView.hidden = false;
      pollJob();
    } catch (error) {
      showMessage(error.message);
      setBusy(elements.downloadButton, false, "取得する");
    }
  }

  async function pollJob() {
    clearTimeout(pollTimer);
    if (!currentJob) return;
    try {
      const result = await api(`/jobs/${encodeURIComponent(currentJob.id)}`);
      currentJob = result.job;
      if (currentJob.status === "ready") {
        renderReady(currentJob);
        await loadJobs();
        return;
      }
      if (["failed", "expired", "deleted"].includes(currentJob.status)) {
        elements.progressView.hidden = true;
        showMessage(currentJob.error || "取得処理を完了できませんでした。");
        await loadJobs();
        return;
      }
      elements.progressLabel.textContent = currentJob.status === "processing" ? "ダウンロードと検査を行っています" : "取得準備中";
      pollTimer = window.setTimeout(pollJob, 2000);
    } catch (error) {
      showMessage(error.message);
      pollTimer = window.setTimeout(pollJob, 5000);
    }
  }

  function renderAnalysis(job) {
    const value = job.analysis || {};
    elements.analysisTitle.textContent = value.title || "メディアを検出しました";
    elements.analysisMethod.textContent = extractorLabel(value.extractor);
    renderDetails(elements.sourceDetails, [
      ["サイト", value.site || job.sourceHostname], ["ホスト", value.finalHostname || job.sourceHostname],
      ["投稿者", value.uploader || "不明"], ["投稿日", value.publishedAt || "不明"],
      ["メディア", `${(value.media || []).length}件`], ["取得方法", extractorLabel(value.extractor)]
    ]);
    elements.analysisWarning.textContent = value.warning || "";
    elements.analysisWarning.hidden = !value.warning;
    elements.mediaList.replaceChildren(document.createElement("legend"));
    elements.mediaList.firstElementChild.textContent = "取得するメディア";
    for (const media of value.media || []) {
      const label = document.createElement("label");
      label.className = `media-choice${media.downloadable ? "" : " unavailable"}`;
      const input = document.createElement("input");
      input.type = "radio"; input.name = "media"; input.value = media.mediaId; input.disabled = !media.downloadable;
      const content = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = media.title || "メディア";
      const detail = document.createElement("small");
      detail.textContent = mediaSummary(media);
      content.append(title, detail);
      if (!media.downloadable && media.unavailableReason) {
        const reason = document.createElement("small"); reason.textContent = media.unavailableReason; content.append(reason);
      }
      label.append(input, content);
      elements.mediaList.append(label);
    }
    const first = elements.mediaList.querySelector("input:not(:disabled)");
    if (first) first.checked = true;
    elements.downloadButton.disabled = !first;
    elements.rightsConfirmed.checked = false;
    elements.analysisView.hidden = false;
  }

  function renderReady(job) {
    elements.progressView.hidden = true;
    renderDetails(elements.fileDetails, [["ファイル", job.filename || "download"], ["形式", job.mimeType || "不明"], ["処理方式", normalizationLabel(job.normalizationMode)], ["サイズ", sizeText(job.actualSize)], ["SHA-256", job.sha256 || "不明"]]);
    elements.fileDownload.href = `/downloader/api/jobs/${encodeURIComponent(job.id)}/file`;
    elements.fileDownload.setAttribute("download", job.filename || "download");
    elements.expiryNote.textContent = `保存期限：${dateText(job.expiresAt)}（最大30分で自動削除）`;
    elements.readyView.hidden = false;
  }

  async function loadJobs() {
    try {
      const result = await api("/jobs");
      elements.jobList.replaceChildren();
      if (!result.jobs?.length) {
        const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "処理履歴はありません。"; elements.jobList.append(empty); return;
      }
      for (const job of result.jobs) {
        const row = document.createElement("article"); row.className = "job";
        const info = document.createElement("div");
        const host = document.createElement("p"); host.textContent = `${job.sourceHostname}${job.sourcePathHint || "/"}`;
        const date = document.createElement("small"); date.textContent = dateText(job.createdAt);
        const status = document.createElement("span"); status.className = "job-status"; status.textContent = statusLabel(job.status);
        info.append(host, date); row.append(info, status); elements.jobList.append(row);
      }
    } catch (error) {
      if (error.status === 401) showLogin();
      else showMessage(error.message);
    }
  }

  function showLogin() { elements.loginView.hidden = false; elements.appView.hidden = true; elements.logout.hidden = true; }
  function showApp() { elements.loginView.hidden = true; elements.appView.hidden = false; elements.logout.hidden = false; hideMessage(); }
  function clearViews() { clearTimeout(pollTimer); currentJob = null; elements.analysisView.hidden = true; elements.progressView.hidden = true; elements.readyView.hidden = true; }
  function showMessage(text) { elements.message.textContent = String(text || "処理を完了できませんでした。"); elements.message.hidden = false; }
  function hideMessage() { elements.message.hidden = true; elements.message.textContent = ""; }
  function setBusy(button, busy, label) { button.disabled = busy; button.textContent = label; }
  function renderDetails(target, entries) { target.replaceChildren(); for (const [label, value] of entries) { const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = String(value); row.append(term, detail); target.append(row); } }
  function requestId() { return `web_${crypto.randomUUID().replace(/-/g, "")}`; }
  function sizeText(value) { const size = Number(value); if (!Number.isFinite(size)) return "不明"; if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`; if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`; return `${Math.max(1, Math.round(size / 1024))} KB`; }
  function dateText(value) { if (!value) return "不明"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "不明" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(date); }
  function extractorLabel(value) { const text = String(value || "unknown"); if (text === "direct") return "Direct Media"; if (text.includes("browser")) return "Browser解析"; if (text.includes("generic")) return "Generic解析"; return text; }
  function normalizationLabel(value) { return ({ PASS_THROUGH: "そのまま", REMUX: "無劣化Remux", PARTIAL_TRANSCODE: "非互換部分のみ変換", FULL_TRANSCODE: "MP4へ再エンコード", NOT_APPLICABLE: "変換なし" })[value] || "実体検査済み"; }
  function mediaSummary(media) { return [media.mediaType === "audio" ? "音声" : media.mediaType === "image" ? "画像" : "動画", media.width && media.height ? `${media.width}×${media.height}` : null, media.container?.toUpperCase(), media.videoCodec, media.audioCodec, media.estimatedSize ? sizeText(media.estimatedSize) : "サイズ不明", String(media.delivery || "").toUpperCase(), media.mediaType === "video" ? "最終形式 MP4（方式は実体検査後に決定）" : null].filter(Boolean).join(" · "); }
  function statusLabel(status) { return ({ analyzing: "解析中", analyzed: "解析済み", queued: "準備中", processing: "取得・検査中", ready: "ダウンロード可能", failed: "失敗", expired: "期限終了", deleted: "削除済み" })[status] || status; }
  function userMessage(error) { return error?.name === "PasskeyCancelledError" ? "端末のロック解除がキャンセルされたか、操作の有効期限が切れました。もう一度お試しください。" : error?.message || "パスキー処理を完了できませんでした。"; }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${BASE}${path}`, { method: options.method || "GET", credentials: "same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error || "処理を完了できませんでした。"); error.status = response.status; throw error; }
    return body;
  }
})();

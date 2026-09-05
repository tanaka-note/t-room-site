(() => {
  "use strict";

  const BASE = "/downloader/api";
  const elements = Object.fromEntries([
    "message", "login-view", "passkey-login", "logout", "app-view", "analyze-form", "source-url",
    "analyze-button", "analysis-view", "analysis-title", "analysis-method", "source-details",
    "analysis-warning", "download-form", "media-list", "rights-confirmed", "youtube-rights-notice",
    "youtube-rights-confirmed", "download-button",
    "progress-view", "progress-label", "ready-view", "file-details", "file-download", "expiry-note",
    "usage-section", "refresh-usage", "usage-periods", "usage-summary", "usage-alert",
    "usage-normalizations", "usage-security", "usage-capacity", "usage-daily", "usage-pricing", "usage-notes",
    "job-list", "refresh-jobs"
  ].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));
  let currentJob = null;
  let pollTimer = 0;
  let usageData = null;
  let usagePeriod = "today";

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    bindEvents();
    try {
      const session = await api("/session");
      showApp(session.isParent === true);
      await Promise.all([loadJobs(), session.isParent === true ? loadUsage() : Promise.resolve()]);
    } catch (error) {
      if (error.status === 401) showLogin();
      else showMessage(error.message);
    }
  }

  function bindEvents() {
    elements.passkeyLogin.addEventListener("click", login);
    elements.logout.addEventListener("click", logout);
    elements.analyzeForm.addEventListener("submit", analyze);
    elements.sourceUrl.addEventListener("input", updateYoutubeConfirmation);
    elements.downloadForm.addEventListener("submit", requestDownload);
    elements.refreshJobs.addEventListener("click", loadJobs);
    elements.refreshUsage.addEventListener("click", loadUsage);
    elements.usagePeriods.addEventListener("click", selectUsagePeriod);
    elements.fileDownload.addEventListener("click", prepareDownloadAttempt);
  }

  async function login() {
    setBusy(elements.passkeyLogin, true, "本人確認中…");
    try {
      const authentication = await window.TRoomPasskeys.authenticate("downloader");
      const session = await api("/passkey/handoff", { method: "POST", body: { handoffToken: authentication.handoff.handoffToken } });
      showApp(session.isParent === true);
      await Promise.all([loadJobs(), session.isParent === true ? loadUsage() : Promise.resolve()]);
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
      const result = await api("/analyze", {
        method: "POST",
        body: { url, clientRequestId: requestId(), youtubeRightsConfirmed: elements.youtubeRightsConfirmed.checked }
      });
      currentJob = result.job;
      if (result.job.status === "analyzed") renderAnalysis(result.job);
      else {
        elements.progressView.hidden = false;
        elements.progressLabel.textContent = "URLを解析しています";
        pollJob();
      }
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
        body: {
          url: elements.sourceUrl.value.trim(), mediaId,
          rightsConfirmed: elements.rightsConfirmed.checked,
          youtubeRightsConfirmed: elements.youtubeRightsConfirmed.checked
        }
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
      if (currentJob.status === "analyzed") {
        elements.progressView.hidden = true;
        renderAnalysis(currentJob);
        await loadJobs();
        return;
      }
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
      elements.progressLabel.textContent = progressLabel(currentJob);
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
    const youtube = isYoutubeAnalysis(value);
    elements.youtubeRightsNotice.hidden = !youtube;
    elements.youtubeRightsConfirmed.required = youtube;
    elements.analysisView.hidden = false;
  }

  function renderReady(job) {
    elements.progressView.hidden = true;
    renderDetails(elements.fileDetails, [["ファイル", job.filename || "download"], ["形式", job.mimeType || "不明"], ["処理方式", normalizationLabel(job.normalizationMode)], ["サイズ", sizeText(job.actualSize)], ["SHA-256", job.sha256 || "不明"]]);
    elements.fileDownload.dataset.jobId = job.id;
    elements.fileDownload.href = `/downloader/api/jobs/${encodeURIComponent(job.id)}/file?attempt=${encodeURIComponent(downloadAttemptId())}`;
    elements.fileDownload.setAttribute("download", job.filename || "download");
    elements.expiryNote.textContent = `保存期限：${dateText(job.expiresAt)}（最大12時間で自動削除）`;
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
        const host = document.createElement("p"); host.textContent = job.sourceHostname;
        const date = document.createElement("small"); date.textContent = dateText(job.createdAt);
        const actions = document.createElement("div"); actions.className = "job-actions";
        const status = document.createElement("span"); status.className = "job-status";
        status.textContent = job.status === "ready" && !isDownloadAvailable(job) ? "期限終了" : statusLabel(job.status);
        actions.append(status);
        if (isDownloadAvailable(job)) {
          const link = document.createElement("a");
          link.className = "job-download";
          link.textContent = "再ダウンロード";
          link.href = jobDownloadHref(job.id);
          link.setAttribute("download", job.filename || "download");
          link.addEventListener("click", () => { link.href = jobDownloadHref(job.id); });
          actions.append(link);
        }
        info.append(host, date); row.append(info, actions); elements.jobList.append(row);
      }
    } catch (error) {
      if (error.status === 401) showLogin();
      else showMessage(error.message);
    }
  }

  async function loadUsage() {
    setBusy(elements.refreshUsage, true, "更新中…");
    try {
      usageData = await api("/admin/usage");
      renderUsage();
    } catch (error) {
      if (error.status === 403) elements.usageSection.hidden = true;
      else showMessage(error.message);
    } finally {
      setBusy(elements.refreshUsage, false, "更新");
    }
  }

  function selectUsagePeriod(event) {
    const button = event.target.closest("button[data-period]");
    if (!button || !usageData?.periods?.[button.dataset.period]) return;
    usagePeriod = button.dataset.period;
    for (const item of elements.usagePeriods.querySelectorAll("button[data-period]")) {
      const active = item.dataset.period === usagePeriod;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    }
    renderUsage();
  }

  function renderUsage() {
    const usage = usageData?.periods?.[usagePeriod];
    if (!usage) return;
    const summary = [
      ["URL解析", countText(usage.analyzeRequests)],
      ["取得要求", countText(usage.downloadRequests)],
      ["処理成功", countText(usage.processingSuccesses)],
      ["実ファイル取得", countText(usage.fileDeliveryStarts)],
      ["総配信容量", sizeText(usage.deliveredBytes)],
      ["取得元容量", sizeText(usage.sourceBytes)],
      ["拒否", countText(usage.rejected)],
      ["失敗", countText(usage.failed)],
      ["脅威検知", countText(Number(usage.security?.malware_detected || 0) + Number(usage.security?.yara_detected || 0))],
      ["今月推定追加", usdText(usageData.pricing?.estimatedAdditionalUsd)]
    ];
    elements.usageSummary.replaceChildren(...summary.map(([label, value]) => usageMetric(label, value)));
    renderDetails(elements.usageNormalizations, Object.entries(usage.normalization || {}).map(([name, count]) => [normalizationLabel(name), countText(count)]));
    renderDetails(elements.usageSecurity, Object.entries(usage.security || {}).map(([name, count]) => [securityLabel(name), countText(count)]));
    renderDetails(elements.usageCapacity, [
      ["取得元から取得", sizeText(usage.sourceBytes)],
      ["R2へ保存", sizeText(usage.r2StoredBytes)],
      ["利用者へ配信", sizeText(usage.deliveredBytes)],
      ["利用者による削除", countText(usage.deleted)],
      ["期限切れ", countText(usage.expired)]
    ]);
    const alerts = usageData.signals?.alerts || [];
    elements.usageAlert.textContent = alerts.join(" ");
    elements.usageAlert.hidden = !alerts.length;
    renderUsageDaily(usageData.recentDaily || []);
    renderUsagePricing(usageData.pricing);
  }

  function usageMetric(label, value) {
    const item = document.createElement("div");
    item.className = "usage-metric";
    const term = document.createElement("span"); term.textContent = label;
    const amount = document.createElement("strong"); amount.textContent = value;
    item.append(term, amount);
    return item;
  }

  function renderUsageDaily(rows) {
    elements.usageDaily.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "集計データはまだありません。"; elements.usageDaily.append(empty); return;
    }
    for (const row of rows.slice(-14)) {
      const item = document.createElement("article"); item.className = "usage-day";
      const date = document.createElement("time"); date.dateTime = row.date; date.textContent = row.date.slice(5).replace("-", "/");
      const count = document.createElement("strong"); count.textContent = `${Number(row.processingSuccesses || 0).toLocaleString("ja-JP")}件成功`;
      const detail = document.createElement("small"); detail.textContent = `取得 ${Number(row.fileDeliveryStarts || 0).toLocaleString("ja-JP")} · 拒否/失敗 ${Number(row.rejected || 0) + Number(row.failed || 0)}`;
      item.append(date, count, detail); elements.usageDaily.append(item);
    }
  }

  function renderUsagePricing(pricing) {
    elements.usagePricing.replaceChildren();
    elements.usageNotes.replaceChildren();
    if (!pricing) return;
    const total = document.createElement("strong"); total.textContent = usdText(pricing.estimatedAdditionalUsd);
    const label = document.createElement("span"); label.textContent = `今月の計測済み範囲 · 料金表 ${pricing.pricingAsOf}時点`;
    elements.usagePricing.append(total, label);
    for (const component of pricing.components || []) {
      const row = document.createElement("div"); row.className = "usage-price-row";
      const name = document.createElement("span"); name.textContent = `${component.name}${component.measured ? "" : "（参考）"}`;
      const amount = document.createElement("span"); amount.textContent = component.available === false ? "取得不能" : usdText(component.estimatedAdditionalUsd);
      row.append(name, amount); elements.usagePricing.append(row);
    }
    for (const note of pricing.notes || []) {
      const paragraph = document.createElement("p"); paragraph.textContent = note; elements.usageNotes.append(paragraph);
    }
  }

  function prepareDownloadAttempt() {
    const jobId = elements.fileDownload.dataset.jobId;
    if (jobId) elements.fileDownload.href = jobDownloadHref(jobId);
  }

  function showLogin() { elements.loginView.hidden = false; elements.appView.hidden = true; elements.usageSection.hidden = true; elements.logout.hidden = true; }
  function showApp(isParent = false) { elements.loginView.hidden = true; elements.appView.hidden = false; elements.usageSection.hidden = !isParent; elements.logout.hidden = false; hideMessage(); }
  function clearViews() { clearTimeout(pollTimer); currentJob = null; elements.analysisView.hidden = true; elements.progressView.hidden = true; elements.readyView.hidden = true; }
  function showMessage(text) { elements.message.textContent = String(text || "処理を完了できませんでした。"); elements.message.hidden = false; }
  function hideMessage() { elements.message.hidden = true; elements.message.textContent = ""; }
  function setBusy(button, busy, label) { button.disabled = busy; button.textContent = label; }
  function renderDetails(target, entries) { target.replaceChildren(); for (const [label, value] of entries) { const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = String(value); row.append(term, detail); target.append(row); } }
  function requestId() { return `web_${crypto.randomUUID().replace(/-/g, "")}`; }
  function downloadAttemptId() { return `file_${crypto.randomUUID().replace(/-/g, "")}`; }
  function countText(value) { return `${Number(value || 0).toLocaleString("ja-JP")}件`; }
  function usdText(value) { const number = Number(value || 0); return `$${number < 0.01 ? number.toFixed(6) : number.toFixed(2)}`; }
  function sizeText(value) { const size = Number(value); if (!Number.isFinite(size)) return "不明"; if (size <= 0) return "0 KB"; if (size < 1024) return `${Math.round(size)} B`; if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`; if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`; return `${Math.round(size / 1024)} KB`; }
  function dateText(value) { if (!value) return "不明"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "不明" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(date); }
  function isDownloadAvailable(job) { const expires = Date.parse(job?.expiresAt || ""); return job?.status === "ready" && Number.isFinite(expires) && expires > Date.now(); }
  function jobDownloadHref(jobId) { return `/downloader/api/jobs/${encodeURIComponent(jobId)}/file?attempt=${encodeURIComponent(downloadAttemptId())}`; }
  function progressLabel(job) {
    if (job?.status === "analyzing") return "URLを解析しています";
    if (job?.status !== "processing") return "取得準備中";
    return ({
      starting: "処理環境を準備しています",
      downloading: "ファイルを取得しています",
      validating: "メディアを確認しています",
      processing: "メディアを処理しています",
      scanning: "安全性を検査しています",
      saving: "保存しています",
      finalizing: "完了処理を行っています"
    })[job.progressStage] || "取得処理を開始しています";
  }
  function extractorLabel(value) { const text = String(value || "unknown"); if (text === "direct") return "Direct Media"; if (text.includes("browser")) return "Browser解析"; if (text.includes("generic")) return "Generic解析"; return text; }
  function normalizationLabel(value) { return ({ PASS_THROUGH: "そのまま", REMUX: "無劣化Remux", PARTIAL_TRANSCODE: "非互換部分のみ変換", FULL_TRANSCODE: "MP4へ再エンコード", NOT_APPLICABLE: "変換なし" })[value] || "実体検査済み"; }
  function securityLabel(value) { return ({ malware_detected: "Malware検知", yara_detected: "YARA検知", clamav_error: "ClamAV異常", yara_error: "YARA異常", scanner_timeout: "Scanner timeout", scanner_unavailable: "Scanner停止", file_type_mismatch: "形式不一致", malformed_media: "破損メディア", processing_budget_exceeded: "処理予算超過", deadline_exceeded: "Deadline超過", ssrf_rejected: "SSRF拒否", rate_limited: "Rate limit", other_reject: "その他拒否", other_failed: "その他失敗" })[value] || value; }
  function mediaSummary(media) { return [media.mediaType === "audio" ? "音声" : media.mediaType === "image" ? "画像" : "動画", media.width && media.height ? `${media.width}×${media.height}` : null, media.container?.toUpperCase(), media.videoCodec, media.audioCodec, media.estimatedSize ? sizeText(media.estimatedSize) : "サイズ不明", String(media.delivery || "").toUpperCase(), media.mediaType === "video" ? "最終形式 MP4（方式は実体検査後に決定）" : null].filter(Boolean).join(" · "); }
  function statusLabel(status) { return ({ analyzing: "解析中", analyzed: "解析済み", queued: "準備中", processing: "取得・検査中", ready: "ダウンロード可能", failed: "失敗", expired: "期限終了", deleted: "削除済み" })[status] || status; }
  function userMessage(error) { return error?.name === "PasskeyCancelledError" ? "端末のロック解除がキャンセルされたか、操作の有効期限が切れました。もう一度お試しください。" : error?.message || "パスキー処理を完了できませんでした。"; }
  function isYoutubeAnalysis(value) { const text = `${value.hostname || ""} ${value.finalHostname || ""} ${value.site || ""} ${value.extractor || ""}`.toLowerCase(); return text.includes("youtube") || text.includes("youtu.be") || text.includes("googlevideo.com"); }
  function isYoutubeUrl(value) { try { const host = new URL(value).hostname.toLowerCase().replace(/\.$/, ""); return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com"); } catch { return false; } }
  function updateYoutubeConfirmation() { const youtube = isYoutubeUrl(elements.sourceUrl.value); elements.youtubeRightsNotice.hidden = !youtube; elements.youtubeRightsConfirmed.required = youtube; if (!youtube) elements.youtubeRightsConfirmed.checked = false; }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${BASE}${path}`, { method: options.method || "GET", credentials: "same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error || "処理を完了できませんでした。"); error.status = response.status; throw error; }
    return body;
  }
})();

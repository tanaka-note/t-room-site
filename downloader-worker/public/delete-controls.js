(() => {
  "use strict";

  const API_BASE = "/downloader/api";
  const READY_DELETE_ID = "file-delete";
  const RETRY_DELAYS_MS = [0, 500, 1500];

  document.addEventListener("DOMContentLoaded", initializeDeleteControls);

  function initializeDeleteControls() {
    const readyButton = document.getElementById(READY_DELETE_ID);
    if (readyButton) readyButton.addEventListener("click", deleteReadyFile);

    const jobList = document.getElementById("job-list");
    if (jobList) {
      installHistoryDeleteButtons(jobList);
      new MutationObserver(() => installHistoryDeleteButtons(jobList)).observe(jobList, { childList: true, subtree: true });
    }

    const expiryNote = document.getElementById("expiry-note");
    if (expiryNote) {
      normalizeExpiryCopy(expiryNote);
      new MutationObserver(() => normalizeExpiryCopy(expiryNote)).observe(expiryNote, { childList: true, characterData: true, subtree: true });
    }
  }

  async function deleteReadyFile() {
    const downloadLink = document.getElementById("file-download");
    const button = document.getElementById(READY_DELETE_ID);
    const jobId = String(downloadLink?.dataset?.jobId || "");
    if (!jobId || !button) return;
    const deleted = await confirmAndDelete(jobId, button);
    if (!deleted) return;

    downloadLink.removeAttribute("href");
    downloadLink.removeAttribute("download");
    downloadLink.hidden = true;
    button.hidden = true;
    const expiryNote = document.getElementById("expiry-note");
    if (expiryNote) expiryNote.textContent = "R2上の一時ファイルを削除しました。再ダウンロードはできません。";
    document.getElementById("refresh-jobs")?.click();
  }

  function installHistoryDeleteButtons(jobList) {
    for (const row of jobList.querySelectorAll(".job")) {
      if (row.querySelector(".job-delete")) continue;
      const downloadLink = row.querySelector(".job-download");
      const jobId = jobIdFromDownloadHref(downloadLink?.getAttribute("href"));
      if (!jobId) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button job-delete";
      button.textContent = "削除";
      button.addEventListener("click", async () => {
        const deleted = await confirmAndDelete(jobId, button);
        if (deleted) document.getElementById("refresh-jobs")?.click();
      });
      row.querySelector(".job-actions")?.append(button);
    }
  }

  function jobIdFromDownloadHref(value) {
    try {
      const pathname = new URL(String(value || ""), location.origin).pathname;
      return pathname.match(/^\/downloader\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/file$/)?.[1] || "";
    } catch {
      return "";
    }
  }

  async function confirmAndDelete(jobId, button) {
    const confirmed = window.confirm(
      "R2上の一時ファイルを削除します。\n削除後は再ダウンロードできません。\nダウンロードが完了していることを確認してください。"
    );
    if (!confirmed) return false;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "削除中…";
    hideDeleteError();
    try {
      await deleteWithVerification(jobId);
      return true;
    } catch (error) {
      showDeleteError(error?.message || "一時ファイルを削除できませんでした。もう一度お試しください。1時間以内の自動削除も有効です。");
      return false;
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function deleteWithVerification(jobId) {
    let lastError = null;
    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs) await delay(delayMs);
      try {
        const response = await api(`/jobs/${encodeURIComponent(jobId)}/delete`, { method: "POST", body: {} });
        if (response?.ok !== true) throw new Error("一時ファイルの削除結果を確認できませんでした。");
        const result = await api(`/jobs/${encodeURIComponent(jobId)}`);
        if (result?.job?.status === "deleted") return;
        throw new Error("一時ファイルの削除状態を確認できませんでした。");
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break;
      }
    }
    throw lastError || new Error("一時ファイルを削除できませんでした。もう一度お試しください。1時間以内の自動削除も有効です。");
  }

  function isRetryable(error) {
    const status = Number(error?.status || 0);
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method || "GET",
        credentials: "same-origin",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      const error = new Error("通信が不安定なため削除を確認できませんでした。もう一度お試しください。1時間以内の自動削除も有効です。");
      error.status = 0;
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "一時ファイルを削除できませんでした。");
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function normalizeExpiryCopy(node) {
    const current = node.textContent || "";
    const next = current.replace("最大12時間で自動削除", "最大1時間で自動削除");
    if (next !== current) node.textContent = next;
  }

  function showDeleteError(message) {
    const element = document.getElementById("message");
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
  }

  function hideDeleteError() {
    const element = document.getElementById("message");
    if (element) element.hidden = true;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();

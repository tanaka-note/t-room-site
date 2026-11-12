(function () {
  "use strict";

  const BUILD_META = "troom-app-build";
  const WORKER_META = "troom-service-worker";
  const AUTO_UPDATE_META = "troom-auto-update";
  const AUTO_UPDATE_ENABLED = "enabled";
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const RETRY_INTERVAL_MS = 15 * 1000;
  const RELOAD_GUARD_MS = 60 * 1000;
  const currentBuild = document.querySelector(`meta[name="${BUILD_META}"]`)?.content?.trim() || "";
  const workerUrl = document.querySelector(`meta[name="${WORKER_META}"]`)?.content?.trim() || "";
  const reloadGuardKey = `troom-pwa-update-attempt:${location.pathname}`;

  let lastCheckedAt = 0;
  let checkPromise = null;
  let pendingBuild = "";
  let workerRegistrationPromise = null;
  let retryTimer = 0;

  function isInstalledApp() {
    return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isAutoUpdateEnabled() {
    return document.querySelector(`meta[name="${AUTO_UPDATE_META}"]`)?.content?.trim() === AUTO_UPDATE_ENABLED;
  }

  function canRunAutoUpdate() {
    // installed判定は、共通契約導入前にインストール済みのPWAを安全に移行するために残す。
    return isAutoUpdateEnabled() || isInstalledApp();
  }

  function hasUnfinishedInput() {
    if (document.querySelector('[data-troom-update-block="true"], form[data-troom-dirty="true"]')) return true;
    if ([...document.querySelectorAll('input[type="file"]')].some((input) => input.files?.length)) return true;
    if ([...document.querySelectorAll('input[type="password"]')].some((input) => Boolean(input.value))) return true;
    if ([...document.querySelectorAll("textarea")].some((input) => input.value !== input.defaultValue)) return true;
    if (document.querySelector('[contenteditable="true"]:focus')) return true;
    return Boolean(document.activeElement?.matches?.('[data-troom-protect-unsaved="true"]'));
  }

  function appAllowsReload(publishedBuild) {
    if (hasUnfinishedInput()) return false;
    const event = new CustomEvent("troom:before-auto-update", {
      cancelable: true,
      detail: { currentBuild, publishedBuild }
    });
    return document.dispatchEvent(event);
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      if (document.hidden) return;
      if (pendingBuild) void checkForUpdate({ force: true });
    }, RETRY_INTERVAL_MS);
  }

  function recentReloadAttemptMatches(publishedBuild) {
    try {
      const attempt = JSON.parse(sessionStorage.getItem(reloadGuardKey) || "null");
      return attempt?.build === publishedBuild && Date.now() - Number(attempt.at || 0) < RELOAD_GUARD_MS;
    } catch {
      return false;
    }
  }

  function rememberReloadAttempt(publishedBuild) {
    try {
      sessionStorage.setItem(reloadGuardKey, JSON.stringify({ build: publishedBuild, at: Date.now() }));
    } catch {
      // Private browsing can reject storage. The update itself can continue safely.
    }
  }

  async function ensureServiceWorkerRegistration() {
    if (!("serviceWorker" in navigator) || !workerUrl) return null;
    if (workerRegistrationPromise) return workerRegistrationPromise;
    const resolvedWorkerUrl = new URL(workerUrl, location.href);
    const workerScope = resolvedWorkerUrl.pathname.replace(/[^/]*$/, "");
    workerRegistrationPromise = navigator.serviceWorker.register(workerUrl, {
      scope: workerScope,
      updateViaCache: "none"
    }).catch((error) => {
      workerRegistrationPromise = null;
      throw error;
    });
    return workerRegistrationPromise;
  }

  async function refreshServiceWorker() {
    const registration = await ensureServiceWorkerRegistration();
    if (!registration) return null;
    await registration.update();
    return registration;
  }

  async function fetchPublishedBuild() {
    const target = new URL(location.href);
    target.searchParams.set("app-version-check", String(Date.now()));
    target.hash = "";
    const response = await fetch(target.href, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-TROOM-App-Version": "1" }
    });
    if (!response.ok) throw new Error(`version check failed (${response.status})`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html")
      .querySelector(`meta[name="${BUILD_META}"]`)?.content?.trim() || "";
  }

  async function checkForUpdate({ force = false } = {}) {
    if (!canRunAutoUpdate() || !currentBuild || !navigator.onLine) return false;
    const now = Date.now();
    if (!force && !pendingBuild && now - lastCheckedAt < CHECK_INTERVAL_MS) return false;
    if (checkPromise) return checkPromise;

    lastCheckedAt = now;
    checkPromise = (async () => {
      try {
        const publishedBuild = await fetchPublishedBuild();
        if (!publishedBuild || publishedBuild === currentBuild) {
          pendingBuild = "";
          await refreshServiceWorker().catch(() => {});
          return false;
        }

        pendingBuild = publishedBuild;
        if (!appAllowsReload(publishedBuild)) {
          scheduleRetry();
          return false;
        }
        if (recentReloadAttemptMatches(publishedBuild)) return false;

        await refreshServiceWorker().catch(() => {});
        rememberReloadAttempt(publishedBuild);
        const target = new URL(location.href);
        target.searchParams.set("app-update", publishedBuild);
        target.searchParams.delete("app-version-check");
        location.replace(target.href);
        return true;
      } catch (error) {
        console.warn("Webアプリの自動更新確認に失敗しました", error);
        return false;
      } finally {
        checkPromise = null;
      }
    })();
    return checkPromise;
  }

  window.addEventListener("pageshow", () => void checkForUpdate());
  window.addEventListener("focus", () => void checkForUpdate());
  window.addEventListener("online", () => void checkForUpdate({ force: true }));
  document.addEventListener("troom:auto-update-ready", () => {
    if (pendingBuild) void checkForUpdate({ force: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void checkForUpdate();
  });
  window.TRoomPwaUpdater = Object.freeze({
    currentBuild,
    workerUrl,
    ensureServiceWorkerRegistration,
    refreshServiceWorker,
    checkForUpdate
  });
  window.setTimeout(() => void checkForUpdate(), 0);
  window.setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
})();

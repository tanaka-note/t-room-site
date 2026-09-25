(() => {
  "use strict";
  const CHANNEL = "tlain-downloader2-v1";
  const ALLOWED_ORIGINS = new Set(globalThis.TLAIN_DOWNLOADER2_PROFILE?.controllerOrigins || []);

  function allowedPage() {
    return ALLOWED_ORIGINS.has(location.origin) && location.pathname.startsWith("/downloader2/");
  }

  window.addEventListener("message", (event) => {
    if (!allowedPage() || event.source !== window || !ALLOWED_ORIGINS.has(event.origin)) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== "page-to-extension") return;
    chrome.runtime.sendMessage({ ...message, sourcePath: location.pathname }).then((response) => {
      if (response) window.postMessage({ channel: CHANNEL, direction: "extension-to-page", requestId: message.requestId, ...response }, location.origin);
    }).catch(() => {
      window.postMessage({ channel: CHANNEL, direction: "extension-to-page", requestId: message.requestId, ok: false, error: "Extensionへ接続できません。" }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!allowedPage() || !message || message.channel !== CHANNEL) return;
    window.postMessage({ ...message, direction: "extension-to-page" }, location.origin);
  });

  window.postMessage({ channel: CHANNEL, direction: "extension-to-page", type: "extension.ready", browser: navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome" }, location.origin);
})();

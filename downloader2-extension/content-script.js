(() => {
  "use strict";
  const CHANNEL = "tlain-downloader2-v1";
  const ALLOWED_ORIGIN = "https://tanaka-note.com";

  function allowedPage() {
    return location.origin === ALLOWED_ORIGIN && location.pathname.startsWith("/downloader2/");
  }

  window.addEventListener("message", (event) => {
    if (!allowedPage() || event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== "page-to-extension") return;
    chrome.runtime.sendMessage({ ...message, sourcePath: location.pathname }).then((response) => {
      if (response) window.postMessage({ channel: CHANNEL, direction: "extension-to-page", requestId: message.requestId, ...response }, ALLOWED_ORIGIN);
    }).catch(() => {
      window.postMessage({ channel: CHANNEL, direction: "extension-to-page", requestId: message.requestId, ok: false, error: "Extensionへ接続できません。" }, ALLOWED_ORIGIN);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!allowedPage() || !message || message.channel !== CHANNEL) return;
    window.postMessage({ ...message, direction: "extension-to-page" }, ALLOWED_ORIGIN);
  });

  window.postMessage({ channel: CHANNEL, direction: "extension-to-page", type: "extension.ready", browser: navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome" }, ALLOWED_ORIGIN);
})();

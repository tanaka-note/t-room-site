(function () {
  "use strict";

  let promptEvent = null;
  let installing = false;
  let installed = false;
  let blocked = false;
  const modes = ["standalone", "fullscreen", "minimal-ui"].map(mode => window.matchMedia(`(display-mode: ${mode})`));
  const isStandalone = () => window.navigator.standalone === true || modes.some(mode => mode.matches);
  const buttons = () => document.querySelectorAll("[data-pwa-install]");
  const messages = () => document.querySelectorAll("[data-pwa-install-status]");

  function render() {
    for (const button of buttons()) {
      button.hidden = isStandalone();
      button.disabled = blocked || installing || installed;
      button.textContent = installed ? "追加済み" : installing ? "確認中…" : "ホームへ追加";
      button.dataset.pwaInstallState = isStandalone() ? "standalone" : installed ? "installed" : installing ? "prompting" : promptEvent ? "ready" : "unavailable";
    }
    for (const message of messages()) message.hidden = isStandalone() || !message.textContent;
  }

  function announce(text) {
    for (const message of messages()) message.textContent = text;
    render();
  }

  async function install() {
    if (blocked || installing || installed || isStandalone()) return;
    if (!promptEvent) {
      const apple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      announce(apple
        ? "Safariの共有ボタンから「ホーム画面に追加」を選んでください。"
        : "このページの追加画面はまだ利用できません。ページを再読み込みして少し待ってから、もう一度お試しください。すでに追加済みの場合はホーム画面から開いてください。");
      return;
    }

    // Consume once, before awaiting. A new browser event can arrive while this
    // prompt is pending and must remain available for the next attempt.
    const event = promptEvent;
    promptEvent = null;
    installing = true;
    announce("追加の確認画面を開いています…");
    try {
      // Called synchronously from the user's click to preserve user activation.
      await event.prompt();
      const choice = await event.userChoice;
      if (!installed) announce(choice.outcome === "accepted"
        ? "追加を受け付けました。ホーム画面への反映には時間がかかる場合があります。"
        : "追加をキャンセルしました。もう一度追加する場合は、ページを再読み込みしてからお試しください。");
    } catch {
      if (!installed) announce("追加画面を開けませんでした。ページを再読み込みして、もう一度お試しください。");
    } finally {
      installing = false;
      render();
      document.dispatchEvent(new Event("troom:auto-update-ready"));
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    promptEvent = event;
    installed = false;
    render();
  });
  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    installed = true;
    announce("ホーム画面への追加が完了しました。");
  });
  for (const mode of modes) mode.addEventListener?.("change", render);
  document.addEventListener("troom:before-auto-update", event => {
    if (installing) event.preventDefault();
  });
  window.addEventListener("beforeunload", event => {
    if (installing) { event.preventDefault(); event.returnValue = ""; }
  });

  window.TRoomPwaInstall = {
    get installing() { return installing; },
    setBlocked(value) { blocked = Boolean(value); render(); }
  };
  function bind() {
    for (const button of buttons()) button.addEventListener("click", install);
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();

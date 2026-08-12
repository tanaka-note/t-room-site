"use strict";

const installButton = document.getElementById("install-app-button");
let installPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  if (!installButton) return;
  installButton.hidden = isStandalone();
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  updateInstallButton();
});

installButton?.addEventListener("click", async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    updateInstallButton();
    return;
  }

  const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
  window.alert(isAppleMobile
    ? "Safariの共有ボタンを押し、「ホーム画面に追加」を選択してください。"
    : "ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選択してください。");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", { scope: "./", updateViaCache: "none" });
      await registration.update();
    } catch (error) {
      console.warn("資産運用報告アプリを初期化できませんでした。", error);
    }
  });
}

updateInstallButton();

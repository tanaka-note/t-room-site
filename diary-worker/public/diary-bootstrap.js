(() => {
  const scriptUrl = new URL(document.currentScript.src);
  const button = document.querySelector("#passkey-login");
  const bootView = document.querySelector("#boot-view");
  const loginView = document.querySelector("#login-view");
  const message = document.querySelector("#login-message");
  const installDialog = document.querySelector("#install-app-dialog");
  const installButtons = [...document.querySelectorAll(".install-app-button")];
  const closeButtons = [...installDialog.querySelectorAll("[data-close-dialog]")];
  const events = new AbortController();
  let deferredInstallPrompt = null;
  let runtimePromise;
  const scripts = new Map();

  function showLogin(text = "") {
    document.querySelector("#app-view").hidden = true;
    bootView.hidden = true;
    loginView.hidden = false;
    message.textContent = text;
    button.focus();
  }

  async function api(path, body) {
    const response = await fetch(`/diary/api${path}`, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: body ? { "Content-Type": "application/json", "X-Diary-Request": "1" } : {},
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "日記を読み込めませんでした。");
    return result;
  }

  function loadScript(name) {
    if (scripts.has(name)) return scripts.get(name);
    const pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(`${name}${scriptUrl.search}`, scriptUrl).href;
      script.onload = resolve;
      script.onerror = () => { scripts.delete(name); script.remove(); reject(new Error("日記を読み込めませんでした。もう一度お試しください。")); };
      document.head.append(script);
    });
    scripts.set(name, pending);
    return pending;
  }

  async function enterDiary(session) {
    // A rejected load can be retried, without fetching the runtime before authentication.
    if (!runtimePromise) {
      runtimePromise = Promise.all([
        loadScript("dialog-navigation.js"), loadScript("troom-date-picker.js"),
        import(new URL(`diary.js${scriptUrl.search}`, scriptUrl).href)
      ]).catch(error => { runtimePromise = null; throw error; });
    }
    const [, , runtime] = await runtimePromise;
    if (installDialog.open) installDialog.close();
    await runtime.startDiary(session, deferredInstallPrompt, () => {
      button.disabled = false;
      button.textContent = "パスキーでログイン";
      events.abort();
      return deferredInstallPrompt;
    });
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "確認中...";
    message.textContent = "";
    try {
      const authentication = await TRoomPasskeys.authenticate("diary", links => TRoomPasskeys.chooseLinkDialog(links, "diary"));
      const session = await api("/passkey/handoff", { handoffToken: authentication.handoff.handoffToken });
      await enterDiary(session);
    } catch (error) {
      if (events.signal.aborted) return;
      showLogin(/ID・パスワード/.test(error.message)
        ? "パスキーを利用できるブラウザで開いてください。復旧が必要な場合は管理者へご相談ください。"
        : error.message);
    } finally {
      if (!events.signal.aborted) {
        button.disabled = false;
        button.textContent = "パスキーでログイン";
      }
    }
  }, { signal: events.signal });

  function updateInstallButtons() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    installButtons.forEach(button => { button.hidden = standalone; });
  }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); deferredInstallPrompt = event;
  }, { signal: events.signal });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null; updateInstallButtons();
  }, { signal: events.signal });
  installButtons.forEach(button => button.addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      const prompt = deferredInstallPrompt; deferredInstallPrompt = null;
      await prompt.prompt(); await prompt.userChoice.catch(() => null);
    } else installDialog.showModal();
  }, { signal: events.signal }));
  closeButtons.forEach(button => button.addEventListener("click", () => installDialog.close(), { signal: events.signal }));
  document.addEventListener("troom:before-auto-update", event => {
    if (button.disabled || document.querySelector("dialog[open]")) event.preventDefault();
  }, { signal: events.signal });
  updateInstallButtons();
  (async () => {
    try {
      const session = await api("/session");
      if (session.authenticated) await enterDiary(session);
      else showLogin();
    } catch (error) { showLogin(error.message); }
  })();
})();

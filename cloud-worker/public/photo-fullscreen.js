(() => {
  "use strict";

  function create({ dialog, container, button, isPhoto, onError }) {
    let entering = false, cancelEntry = false, exiting = null, wasActive = false, ownsFullscreen = false;
    const inertSiblings = new Map();
    const active = () => ownsFullscreen && (document.fullscreenElement || document.webkitFullscreenElement) === container;
    const supported = () => Boolean((container.requestFullscreen && document.fullscreenEnabled !== false)
      || (container.webkitRequestFullscreen && document.webkitFullscreenEnabled !== false));
    const controls = () => [...container.querySelectorAll("button, a[href], input, [tabindex]")]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length
        && getComputedStyle(element).visibility !== "hidden");
    function sync() {
      const full = active();
      if (!full && !entering) ownsFullscreen = false;
      button.hidden = !isPhoto() || !supported();
      button.disabled = entering || Boolean(exiting);
      button.setAttribute("aria-pressed", String(full));
      button.setAttribute("aria-label", full ? "全画面表示を終了" : "写真を全画面で表示");
      button.title = button.getAttribute("aria-label");
      if (full) {
        for (const sibling of dialog.children) {
          if (sibling === container) continue;
          if (!inertSiblings.has(sibling)) inertSiblings.set(sibling, sibling.inert);
          sibling.inert = true;
        }
        if (!container.contains(document.activeElement)) controls()[0]?.focus({ preventScroll: true });
      } else {
        for (const [sibling, inert] of inertSiblings) sibling.inert = inert;
        inertSiblings.clear();
      }
    }
    async function exit() {
      if (exiting) return exiting;
      if (!active()) return;
      exiting = (async () => {
        try {
          const leave = document.exitFullscreen || document.webkitExitFullscreen;
          await leave.call(document);
        } catch { onError(); }
      })();
      sync();
      await exiting;
      exiting = null;
      sync();
      if (isPhoto()) button.focus({ preventScroll: true });
    }
    async function toggle(event) {
      event.preventDefault();
      event.stopPropagation();
      if (entering || exiting) return;
      if (active()) { await exit(); return; }
      if (!isPhoto() || !supported()) return;
      entering = true; ownsFullscreen = true; cancelEntry = false; sync();
      try {
        const enter = container.requestFullscreen || container.webkitRequestFullscreen;
        await enter.call(container);
        if (cancelEntry || !isPhoto()) await exit();
      } catch { onError(); }
      finally {
        entering = false; sync();
        if (!active() && isPhoto()) button.focus({ preventScroll: true });
      }
    }
    function changed() {
      const full = active();
      sync();
      if (full && !isPhoto()) void exit();
      if (wasActive && !full && isPhoto()) button.focus({ preventScroll: true });
      wasActive = full;
    }
    button.addEventListener("click", toggle);
    document.addEventListener("keydown", event => {
      if (event.key !== "Tab" || !active()) return;
      const buttons = controls();
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next].focus({ preventScroll: true });
    });
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("webkitfullscreenchange", changed);
    sync();
    return Object.freeze({
      sync, exit,
      consumeCancel() {
        if (!active() && !entering && !exiting) return false;
        cancelEntry = true;
        void exit();
        return true;
      }
    });
  }
  globalThis.TCloudPhotoFullscreen = Object.freeze({ create });
})();

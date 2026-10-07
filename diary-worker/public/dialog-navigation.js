/* Shared by Diary and Billing. Only explicitly registered dialogs are managed. */
(() => {
  function create({ key, window: win = window, document: doc = document }) {
    const page = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const registered = new Map(), visits = new Map();
    let stack = [], pending = null, bounce = false;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const state = () => ({ ...(win.history.state || {}), [key]: { page, stack } });
    const targetStack = () => win.history.state?.[key]?.page === page ? win.history.state[key].stack : null;
    win.history.replaceState(state(), "", win.location.href);

    function positions(record) {
      const root = record.dialog;
      const nodes = record.scrollRoots ? [root, ...record.scrollRoots()] : [root, ...root.querySelectorAll("*")];
      return [...new Set(nodes)].filter(node => node?.isConnected && (node === root || root.contains(node)))
        .filter(node => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
        .map(node => [node, node.scrollLeft, node.scrollTop]);
    }
    function restorePosition(saved) {
      for (const [node, x, y] of saved || []) if (node.isConnected) { node.scrollLeft = x; node.scrollTop = y; }
    }
    function snapshot() {
      for (const visit of stack) {
        const record = registered.get(visit.id), saved = visits.get(visit.token);
        saved.positions = positions(record);
        if (record.capture) saved.data = record.capture();
      }
    }
    function top(id) { return stack.at(-1)?.id === id; }
    function finish(visit) {
      const record = registered.get(visit.id), saved = visits.get(visit.token);
      if (record.dialog.open) record.dialog.close();
      record.onClose?.();
      const parent = stack.at(-1);
      if (parent) restorePosition(visits.get(parent.token)?.positions);
      const focus = saved?.focus;
      if (focus?.isConnected && (!parent || registered.get(parent.id).dialog.contains(focus))) focus.focus({ preventScroll: true });
      else if (parent) registered.get(parent.id).dialog.querySelector("button, input, select, textarea, [tabindex]")?.focus({ preventScroll: true });
      if (saved?.pagePosition) win.scrollTo(saved.pagePosition.x, saved.pagePosition.y);
    }
    function complete(target) {
      while (stack.length > target.length) {
        const visit = stack.pop();
        finish(visit);
      }
      const done = pending;
      pending = null;
      done?.resolve(true);
      done?.after?.();
    }
    function open(id) {
      const record = registered.get(id);
      if (!record || record.dialog.open || pending || bounce) return false;
      snapshot();
      const visit = { id, token: `${page}-${Math.random().toString(36).slice(2)}` };
      visits.set(visit.token, { focus: doc.activeElement, data: record.capture?.(), positions: [], pagePosition: { x: win.scrollX, y: win.scrollY } });
      record.dialog.showModal();
      stack = [...stack, visit];
      win.history.pushState(state(), "", win.location.href);
      return true;
    }
    function close(id, { force = false, reason = "close", after } = {}) {
      if (pending || bounce || !top(id)) return Promise.resolve(false);
      const record = registered.get(id);
      if (!force && record.guard?.(reason) === false) return Promise.resolve(false);
      snapshot();
      const target = stack.slice(0, -1);
      return new Promise(resolve => {
        pending = { resolve, after, target };
        if (same(targetStack(), stack)) win.history.back();
        else complete(target);
      });
    }
    function onPop() {
      const target = targetStack();
      if (pending) {
        if (same(target, pending.target)) complete(target);
        return;
      }
      if (bounce) {
        if (same(target, stack)) { bounce = false; close(stack.at(-1).id, { reason: "back" }); }
        return;
      }
      if (!target) return;
      const prefix = target.slice(0, Math.min(target.length, stack.length));
      if (!same(prefix, stack.slice(0, prefix.length))) return;
      if (target.length < stack.length) {
        // Restore the owned entry before consulting a guard that may open a child confirmation.
        bounce = true;
        win.history.go(stack.length - target.length);
      } else if (target.length > stack.length) {
        snapshot();
        for (const visit of target.slice(stack.length)) {
          const record = registered.get(visit.id), saved = visits.get(visit.token);
          if (!saved || !record.restore || record.restore(saved.data) === false) break;
          record.dialog.showModal();
          stack = [...stack, visit];
          restorePosition(saved.positions);
        }
        // An editor/confirmation is never reconstructed from history. Return to
        // its safe parent instead of leaving an empty entry that consumes Back.
        if (!same(stack, target)) win.history.go(stack.length - target.length);
      }
    }
    function register(id, options = {}) {
      const dialog = options.dialog || doc.getElementById(id);
      const record = { ...options, dialog };
      registered.set(id, record);
      let start = null;
      const outside = event => {
        if (event.target !== dialog || !top(id) || event.button > 0 || record.blocked?.()) return false;
        const rect = dialog.getBoundingClientRect();
        return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      };
      dialog.addEventListener("pointerdown", event => {
        start = outside(event) ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
      });
      dialog.addEventListener("pointerup", event => {
        const pressed = start;
        start = null;
        if (!pressed || pressed.id !== event.pointerId || !outside(event) || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 8) return;
        event.preventDefault();
        event.stopPropagation();
        if (record.backdrop) record.backdrop();
        else close(id, { reason: "backdrop" });
      });
      dialog.addEventListener("pointercancel", () => { start = null; });
      dialog.addEventListener("wheel", () => { start = null; }, { passive: true });
      dialog.addEventListener("click", event => {
        if (event.target === dialog) { event.preventDefault(); event.stopPropagation(); }
      });
      dialog.addEventListener("cancel", event => {
        if (event.target !== dialog) return;
        event.preventDefault();
        event.stopPropagation();
        if (!record.blocked?.()) close(id, { reason: "cancel" });
      });
    }
    function reset() {
      for (const visit of [...stack].reverse()) registered.get(visit.id).dialog.close();
      stack = [];
      visits.clear();
      pending?.resolve(false);
      pending = null;
      bounce = false;
      win.history.replaceState(state(), "", win.location.href);
    }
    win.addEventListener("popstate", onPop);
    return { register, open, close, reset };
  }
  globalThis.TroomDialogNavigation = { create };
})();

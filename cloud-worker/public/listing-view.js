/* The grid owns its DOM and observer; callers supply display records and intents. */
(() => {
  function create({ grid, highlight, createObserver = globalThis.IntersectionObserver
    ? (callback, options) => new IntersectionObserver(callback, options) : null }) {
    const revisions = new WeakMap();
    let observer = null;
    let observation = null;

    function reset() {
      if (observation) observation.active = false;
      observation = null;
      observer?.disconnect();
      observer = null;
      grid.querySelectorAll(":scope > .item-render-sentinel").forEach(node => node.remove());
    }

    function cardFor(item, kind, createCard, previous = new Map()) {
      const key = kind + ":" + item.id;
      let card = previous.get(key);
      if (!card || revisions.get(card) !== item.revision) card = createCard(kind, item.id);
      card.dataset.renderKey = key;
      revisions.set(card, item.revision);
      return card;
    }

    function render(snapshot, { createCard, renderOther }) {
      reset();
      const { view, generation, listMode, query, limit, folders, files } = snapshot;
      grid.classList.toggle("list-mode", listMode || ["history", "conflicts", "requests", "shares"].includes(view));
      grid.classList.toggle("conflict-overview", view === "conflicts");
      const limited = ["all", "favorites"].includes(view);
      const reuse = limited && grid.dataset.renderGeneration === String(generation);
      const previous = new Map(reuse ? [...grid.querySelectorAll(":scope > [data-render-key]")].map(card => [card.dataset.renderKey, card]) : []);
      if (!reuse) grid.replaceChildren();
      grid.dataset.renderGeneration = String(generation);
      renderOther?.(grid);
      const desired = [];
      let remaining = limited ? limit : Number.POSITIVE_INFINITY;
      const add = (item, kind) => {
        const card = cardFor(item, kind, createCard, previous);
        highlight(card.querySelector("strong"), item.name, query);
        desired.push(card);
      };
      for (const folder of folders.slice(0, remaining)) { add(folder, "folder"); remaining -= 1; }
      for (const file of files.slice(0, remaining)) add(file, "file");
      if (limited) {
        const keep = new Set(desired);
        for (const node of [...grid.children]) if (!keep.has(node)) node.remove();
      }
      let cursor = limited ? grid.firstChild : null;
      for (const card of desired) {
        if (card !== cursor) grid.insertBefore(card, cursor);
        cursor = card.nextSibling;
      }
    }

    function append({ folders, files, limit }, { createCard }) {
      const rendered = grid.querySelectorAll(":scope > .folder-card, :scope > .file-card").length;
      let remaining = Math.max(0, limit - rendered);
      const firstFileCard = grid.querySelector(".file-card");
      for (const folder of folders.slice(0, remaining)) {
        grid.insertBefore(cardFor(folder, "folder", createCard), firstFileCard);
        remaining -= 1;
      }
      for (const file of files.slice(0, remaining)) grid.append(cardFor(file, "file", createCard));
    }

    function observe({ view, total, progressive }, { reveal, loadMore }) {
      reset();
      if (!["all", "favorites"].includes(view)) return;
      const rendered = grid.querySelectorAll(":scope > .folder-card, :scope > .file-card").length;
      if (rendered >= total && !progressive) return;
      const sentinel = grid.ownerDocument.createElement("div");
      sentinel.className = "item-render-sentinel";
      sentinel.setAttribute("aria-hidden", "true");
      grid.append(sentinel);
      const ticket = { active: true };
      observation = ticket;
      const request = () => {
        if (!ticket.active) return;
        ticket.active = false;
        observer?.disconnect();
        if (rendered < total) reveal();
        else loadMore();
      };
      if (!createObserver) {
        const button = grid.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = "さらに表示";
        button.addEventListener("click", request);
        sentinel.append(button);
        return;
      }
      observer = createObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) request();
      }, { rootMargin: "800px 0px" });
      observer.observe(sentinel);
    }

    return Object.freeze({ render, append, observe, reset });
  }

  globalThis.TCloudListingView = Object.freeze({ create });
})();

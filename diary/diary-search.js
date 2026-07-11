(function () {
  const roots = Array.from(document.querySelectorAll("[data-diary-search]"));
  if (!roots.length) return;

  let pagefindPromise;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function loadPagefind() {
    if (!pagefindPromise) {
      pagefindPromise = import("/pagefind/pagefind.js").catch(() => null);
    }
    return pagefindPromise;
  }

  function setupSearch(root) {
    const input = root.querySelector("[data-diary-search-input]");
    const clearButton = root.querySelector("[data-diary-search-clear]");
    const status = root.querySelector("[data-diary-search-status]");
    const results = root.querySelector("[data-diary-search-results]");
    const basePath = root.dataset.diarySearchPath || "/diary/entries/";
    const idleMessage = root.dataset.diarySearchIdle || "日記のタイトルと本文から探します。";
    const maxResults = Number(root.dataset.diarySearchLimit) || 12;
    const fetchLimit = Number(root.dataset.diarySearchFetchLimit) || Math.max(maxResults * 4, 24);
    let timerId;
    let searchRunId = 0;

    if (!input || !status || !results) return;

    function setMessage(message) {
      status.textContent = message;
      results.replaceChildren();
    }

    function updateUrl(query) {
      const url = new URL(window.location.href);
      if (query) {
        url.searchParams.set("q", query);
      } else {
        url.searchParams.delete("q");
      }
      window.history.replaceState({}, "", url);
    }

    function updateClearButton() {
      if (!clearButton) return;
      clearButton.hidden = !input.value.trim();
    }

    function isTargetItem(item) {
      return Boolean(item.url && item.url.startsWith(basePath));
    }

    function renderResults(items) {
      if (!items.length) {
        setMessage("該当する日記はまだありません");
        return;
      }

      status.textContent = `${items.length}件の日記が見つかりました`;
      results.replaceChildren(...items.map((item) => {
        const meta = item.meta || {};
        const link = document.createElement("a");
        link.className = "diary-search-result";
        link.href = item.url;
        link.innerHTML = `
          ${meta.date ? `<time>${escapeHtml(meta.date)}</time>` : ""}
          <h3>${escapeHtml(meta.title || item.url)}</h3>
          <p>${item.excerpt || escapeHtml(item.plain_excerpt || "")}</p>
        `;
        return link;
      }));
    }

    async function runSearch() {
      const runId = ++searchRunId;
      const query = input.value.trim();
      updateClearButton();
      updateUrl(query);
      if (!query) {
        setMessage(idleMessage);
        return;
      }

      status.textContent = "検索しています...";
      const pagefind = await loadPagefind();
      if (runId !== searchRunId) return;
      if (!pagefind) {
        setMessage("検索は公開用のビルド後に利用できます。");
        return;
      }

      const search = await pagefind.debouncedSearch(query, {}, 200);
      if (runId !== searchRunId) return;
      if (!search) return;
      const data = await Promise.all(search.results.slice(0, fetchLimit).map((result) => result.data()));
      if (runId !== searchRunId) return;
      renderResults(data.filter(isTargetItem).slice(0, maxResults));
    }

    input.addEventListener("focus", () => {
      loadPagefind();
    });

    input.addEventListener("input", () => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(runSearch, 180);
    });

    if (clearButton) {
      clearButton.addEventListener("click", () => {
        window.clearTimeout(timerId);
        searchRunId += 1;
        input.value = "";
        updateClearButton();
        updateUrl("");
        setMessage(idleMessage);
        input.focus();
      });
    }

    const initialQuery = new URLSearchParams(window.location.search).get("q");
    if (initialQuery) {
      input.value = initialQuery;
      updateClearButton();
      runSearch();
    } else {
      updateClearButton();
    }
  }

  roots.forEach(setupSearch);
}());

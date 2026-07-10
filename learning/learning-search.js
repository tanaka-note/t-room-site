(function () {
  const roots = Array.from(document.querySelectorAll("[data-learning-search]"));
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
    const input = root.querySelector("[data-learning-search-input]");
    const clearButton = root.querySelector("[data-learning-search-clear]");
    const status = root.querySelector("[data-learning-search-status]");
    const results = root.querySelector("[data-learning-search-results]");
    const subject = root.dataset.learningSearchSubject || "";
    const basePath = root.dataset.learningSearchPath || "/learning/sharoushi/logs/";
    const idleMessage = root.dataset.learningSearchIdle || "キーワードを入力すると、学習ログ記事の本文から探します。";
    const maxResults = Number(root.dataset.learningSearchLimit) || 12;
    const fetchLimit = Number(root.dataset.learningSearchFetchLimit) || Math.max(maxResults * 4, 24);
    let timerId;

    if (!input || !status || !results) return;

    function setMessage(message) {
      status.textContent = message;
      results.replaceChildren();
    }

    function updateClearButton() {
      if (!clearButton) return;
      clearButton.hidden = !input.value.trim();
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

    function isTargetItem(item) {
      const meta = item.meta || {};
      if (!item.url || !item.url.startsWith(basePath)) return false;
      if (subject && meta.subject !== subject) return false;
      return true;
    }

    function renderResults(items) {
      if (!items.length) {
        setMessage("該当する学習ログはまだありません");
        return;
      }

      status.textContent = `${items.length}件の学習ログが見つかりました`;
      results.replaceChildren(...items.map((item) => {
        const meta = item.meta || {};
        const link = document.createElement("a");
        link.className = "learning-search-result";
        link.href = item.url;
        link.innerHTML = `
          <div class="learning-card-meta">
            ${meta.date ? `<span>${escapeHtml(meta.date)}</span>` : ""}
            ${meta.subject ? `<span>${escapeHtml(meta.subject)}</span>` : ""}
            ${meta.category ? `<span>${escapeHtml(meta.category)}</span>` : ""}
          </div>
          <h3>${escapeHtml(meta.title || item.url)}</h3>
          <p>${item.excerpt || escapeHtml(item.plain_excerpt || "")}</p>
          <code>${escapeHtml(item.url)}</code>
        `;
        link.setAttribute("aria-label", `${meta.title || item.url} を開く`);
        return link;
      }));
    }

    async function runSearch() {
      const query = input.value.trim();
      updateClearButton();
      updateUrl(query);
      if (!query) {
        setMessage(idleMessage);
        return;
      }

      status.textContent = "検索しています...";
      const pagefind = await loadPagefind();
      if (!pagefind) {
        setMessage("検索インデックスはビルド後に有効になります。");
        return;
      }

      const search = await pagefind.debouncedSearch(query, {}, 220);
      if (!search) return;

      const items = await Promise.all(search.results.slice(0, fetchLimit).map((result) => result.data()));
      renderResults(items.filter(isTargetItem).slice(0, maxResults));
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

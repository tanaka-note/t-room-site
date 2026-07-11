(function () {
  const roots = document.querySelectorAll("[data-diary-search]");
  if (!roots.length) return;

  let pagefindPromise;

  function loadPagefind() {
    if (!pagefindPromise) pagefindPromise = import("/pagefind/pagefind.js").catch(() => null);
    return pagefindPromise;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  roots.forEach((root) => {
    const input = root.querySelector("[data-diary-search-input]");
    const clear = root.querySelector("[data-diary-search-clear]");
    const status = root.querySelector("[data-diary-search-status]");
    const results = root.querySelector("[data-diary-search-results]");
    let timerId;

    if (!input || !status || !results) return;

    function updateUrl(query) {
      const url = new URL(window.location.href);
      if (query) url.searchParams.set("q", query);
      else url.searchParams.delete("q");
      window.history.replaceState({}, "", url);
    }

    function setIdle() {
      status.textContent = "日記のタイトルと本文から探します。";
      results.replaceChildren();
    }

    function updateClear() {
      if (clear) clear.hidden = !input.value.trim();
    }

    async function searchDiary() {
      const query = input.value.trim();
      updateClear();
      updateUrl(query);
      if (!query) {
        setIdle();
        return;
      }

      status.textContent = "検索しています...";
      const pagefind = await loadPagefind();
      if (!pagefind) {
        status.textContent = "検索は公開用のビルド後に利用できます。";
        results.replaceChildren();
        return;
      }

      const search = await pagefind.debouncedSearch(query, {}, 200);
      if (!search) return;
      const data = await Promise.all(search.results.slice(0, 40).map((result) => result.data()));
      const items = data.filter((item) => item.url?.startsWith("/diary/entries/")).slice(0, 20);

      if (!items.length) {
        status.textContent = "該当する日記はまだありません";
        results.replaceChildren();
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

    input.addEventListener("focus", loadPagefind);
    input.addEventListener("input", () => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(searchDiary, 180);
    });

    clear?.addEventListener("click", () => {
      window.clearTimeout(timerId);
      input.value = "";
      updateClear();
      updateUrl("");
      setIdle();
      input.focus();
    });

    const initialQuery = new URLSearchParams(window.location.search).get("q");
    if (initialQuery) {
      input.value = initialQuery;
      searchDiary();
    } else {
      updateClear();
    }
  });
}());

/* Search input owns DOM synchronization and debounce; listing, access and keys stay with the caller. */
(() => {
  function create({ inputs, clearButtons, resultCount, getQuery, setQuery,
    invalidateSearch, pauseForComposition, loadItems, onResults }) {
    let timer;

    function sync(source = null) {
      clearButtons.forEach(button => { button.hidden = !getQuery(); });
      inputs.forEach(input => {
        if (input !== source && input.value !== getQuery()) input.value = getQuery();
      });
    }

    // Navigation clears the controls without starting or cancelling a listing request.
    function clear() {
      setQuery("");
      sync();
    }

    function runSearch() {
      clearTimeout(timer);
      invalidateSearch();
      if (resultCount && getQuery()) { resultCount.hidden = false; resultCount.textContent = "検索中…"; }
      timer = setTimeout(async () => {
        const result = await loadItems();
        if (result?.ok) onResults();
      }, 250);
    }

    inputs.forEach(input => {
      input.addEventListener("input", event => {
        setQuery(event.target.value.trim());
        sync(event.target);
        if (event.isComposing || event.target.dataset.composing === "1") return;
        runSearch();
      });
      input.addEventListener("compositionstart", () => {
        input.dataset.composing = "1";
        clearTimeout(timer);
        pauseForComposition();
      });
      input.addEventListener("compositionend", () => {
        delete input.dataset.composing;
        setQuery(input.value.trim());
        sync(input);
        runSearch();
      });
    });
    clearButtons.forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      clear();
      runSearch();
      button.ownerDocument.getElementById(button.dataset.searchClear)?.focus({ preventScroll: true });
    }));

    return Object.freeze({ sync, clear });
  }

  globalThis.TCloudSearchInput = Object.freeze({ create });
})();

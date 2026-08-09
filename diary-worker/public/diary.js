(() => {
  const BASE_PATH = "/diary";
  const state = {
    role: null,
    accountName: null,
    canViewTrash: false,
    canPermanentlyDelete: false,
    entries: [],
    entryMap: new Map(),
    offset: 0,
    hasMore: false,
    query: "",
    month: "",
    tag: "",
    trash: false,
    activeEntry: null,
    editorDirty: false,
    dateDraft: null,
    dateWheelTimers: {},
    searchTimer: null,
    requestId: 0,
    deleteMode: null
  };

  const elements = {
    loginView: document.querySelector("#login-view"),
    appView: document.querySelector("#app-view"),
    loginForm: document.querySelector("#login-form"),
    password: document.querySelector("#password"),
    passwordToggle: document.querySelector("#password-toggle"),
    loginMessage: document.querySelector("#login-message"),
    roleLabel: document.querySelector("#role-label"),
    newEntryButton: document.querySelector("#new-entry-button"),
    trashButton: document.querySelector("#trash-button"),
    logoutButton: document.querySelector("#logout-button"),
    searchInput: document.querySelector("#diary-search-input"),
    searchClear: document.querySelector("#diary-search-clear"),
    searchStatus: document.querySelector("#diary-search-status"),
    clearFilters: document.querySelector("#clear-filters-button"),
    listKicker: document.querySelector("#list-kicker"),
    listTitle: document.querySelector("#diary-recent-title"),
    entryList: document.querySelector("#entry-list"),
    loadMore: document.querySelector("#load-more-button"),
    archiveList: document.querySelector("#archive-list"),
    tagList: document.querySelector("#tag-list"),
    entryDialog: document.querySelector("#entry-dialog"),
    detailDate: document.querySelector("#detail-date"),
    detailTitle: document.querySelector("#detail-title"),
    detailAuthor: document.querySelector("#detail-author"),
    detailDeletion: document.querySelector("#detail-deletion"),
    detailTags: document.querySelector("#detail-tags"),
    detailContent: document.querySelector("#detail-content"),
    detailActions: document.querySelector("#detail-actions"),
    restoreActions: document.querySelector("#restore-actions"),
    editEntryButton: document.querySelector("#edit-entry-button"),
    deleteEntryButton: document.querySelector("#delete-entry-button"),
    restoreEntryButton: document.querySelector("#restore-entry-button"),
    permanentlyDeleteEntryButton: document.querySelector("#permanently-delete-entry-button"),
    deleteConfirmDialog: document.querySelector("#delete-confirm-dialog"),
    deleteConfirmTitle: document.querySelector("#delete-confirm-title"),
    deleteConfirmMessage: document.querySelector("#delete-confirm-message"),
    deleteConfirmNo: document.querySelector("#delete-confirm-no"),
    deleteConfirmYes: document.querySelector("#delete-confirm-yes"),
    editorDialog: document.querySelector("#editor-dialog"),
    entryForm: document.querySelector("#entry-form"),
    editorTitle: document.querySelector("#editor-title"),
    entryId: document.querySelector("#entry-id"),
    entryRevision: document.querySelector("#entry-revision"),
    entryDate: document.querySelector("#entry-date"),
    todayButton: document.querySelector("#today-button"),
    entryTitle: document.querySelector("#entry-title"),
    entryContent: document.querySelector("#entry-content"),
    entryTags: document.querySelector("#entry-tags"),
    editorMessage: document.querySelector("#editor-message"),
    saveEntryButton: document.querySelector("#save-entry-button"),
    dateWheelDialog: document.querySelector("#date-wheel-dialog"),
    dateWheelCancel: document.querySelector("#date-wheel-cancel"),
    dateWheelDone: document.querySelector("#date-wheel-done"),
    dateWheelValue: document.querySelector("#date-wheel-value"),
    dateWheelYear: document.querySelector("#date-wheel-year"),
    dateWheelMonth: document.querySelector("#date-wheel-month"),
    dateWheelDay: document.querySelector("#date-wheel-day"),
    toast: document.querySelector("#toast")
  };

  boot();

  async function boot() {
    bindEvents();
    try {
      const session = await api("/session");
      if (session.authenticated) {
        await enterDiary(session);
      } else {
        showLogin();
      }
    } catch (error) {
      showLogin(error.message);
    }
  }

  function bindEvents() {
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.passwordToggle.addEventListener("click", togglePassword);
    elements.logoutButton.addEventListener("click", handleLogout);
    elements.newEntryButton.addEventListener("click", () => openEditor());
    elements.trashButton.addEventListener("click", toggleTrash);
    elements.loadMore.addEventListener("click", () => loadEntries(false));
    elements.clearFilters.addEventListener("click", clearFilters);
    elements.searchClear.addEventListener("click", () => {
      elements.searchInput.value = "";
      state.query = "";
      updateFilterControls();
      loadEntries(true);
      elements.searchInput.focus();
    });
    elements.searchInput.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.query = elements.searchInput.value.trim();
      updateFilterControls();
      state.searchTimer = window.setTimeout(() => loadEntries(true), 300);
    });
    elements.entryList.addEventListener("click", handleEntryListClick);
    elements.archiveList.addEventListener("click", handleArchiveClick);
    elements.tagList.addEventListener("click", handleTagClick);
    elements.editEntryButton.addEventListener("click", () => {
      if (state.activeEntry) {
        elements.entryDialog.close();
        openEditor(state.activeEntry);
      }
    });
    elements.deleteEntryButton.addEventListener("click", requestEntryDeletion);
    elements.restoreEntryButton.addEventListener("click", restoreActiveEntry);
    elements.permanentlyDeleteEntryButton.addEventListener("click", requestPermanentDeletion);
    elements.deleteConfirmNo.addEventListener("click", closeDeleteConfirmation);
    elements.deleteConfirmYes.addEventListener("click", confirmEntryDeletion);
    elements.deleteConfirmDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDeleteConfirmation();
    });
    elements.entryForm.addEventListener("submit", saveEntry);
    elements.todayButton.addEventListener("click", setEntryDateToToday);
    elements.entryDate.addEventListener("pointerdown", handleDatePointerDown);
    elements.entryDate.addEventListener("keydown", handleDateKeydown);
    elements.dateWheelCancel.addEventListener("click", closeDateWheel);
    elements.dateWheelDone.addEventListener("click", applyDateWheel);
    elements.dateWheelDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDateWheel();
    });
    bindDateWheel(elements.dateWheelYear, "year");
    bindDateWheel(elements.dateWheelMonth, "month");
    bindDateWheel(elements.dateWheelDay, "day");
    elements.entryForm.addEventListener("input", () => {
      state.editorDirty = true;
    });

    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
    });
    elements.editorDialog.addEventListener("cancel", (event) => {
      if (state.editorDirty && !window.confirm("入力中の内容を破棄しますか？")) event.preventDefault();
      else state.editorDirty = false;
    });
    window.addEventListener("beforeunload", (event) => {
      if (!state.editorDirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const submit = elements.loginForm.querySelector('button[type="submit"]');
    setBusy(submit, true, "確認中...");
    elements.loginMessage.textContent = "";
    try {
      const result = await api("/login", {
        method: "POST",
        body: { password: elements.password.value }
      });
      elements.password.value = "";
      await enterDiary(result);
    } catch (error) {
      elements.loginMessage.textContent = error.message;
      elements.password.select();
    } finally {
      setBusy(submit, false, "開く");
    }
  }

  async function handleLogout() {
    setBusy(elements.logoutButton, true, "処理中...");
    try {
      await api("/logout", { method: "POST" });
    } catch {
      // Cookie is cleared by the server when available. The local view is closed either way.
    }
    resetState();
    showLogin();
    setBusy(elements.logoutButton, false, "ログアウト");
  }

  function togglePassword() {
    const show = elements.password.type === "password";
    elements.password.type = show ? "text" : "password";
    const label = show ? "パスワードを隠す" : "パスワードを表示";
    elements.passwordToggle.setAttribute("aria-label", label);
    elements.passwordToggle.title = label;
    elements.passwordToggle.setAttribute("aria-pressed", String(show));
  }

  async function enterDiary(session) {
    state.role = session.role;
    state.accountName = session.accountName;
    state.canViewTrash = Boolean(session.canViewTrash);
    state.canPermanentlyDelete = Boolean(session.canPermanentlyDelete);
    elements.loginView.hidden = true;
    elements.appView.hidden = false;
    elements.roleLabel.textContent = session.role === "admin"
      ? `${session.accountName}（管理者）`
      : "閲覧者";
    elements.newEntryButton.hidden = session.role !== "admin";
    elements.trashButton.hidden = !state.canViewTrash;
    await Promise.all([loadMeta(), loadEntries(true)]);
  }

  function showLogin(message = "") {
    elements.loginView.hidden = false;
    elements.appView.hidden = true;
    elements.loginMessage.textContent = message;
    window.setTimeout(() => elements.password.focus(), 0);
  }

  async function loadEntries(reset) {
    const requestId = ++state.requestId;
    if (reset) {
      state.offset = 0;
      state.entries = [];
      state.entryMap.clear();
      elements.entryList.replaceChildren(createEmpty("読み込んでいます..."));
    }
    setBusy(elements.loadMore, true, "読み込んでいます...");
    updateListHeading();

    const parameters = new URLSearchParams({
      limit: "20",
      offset: String(state.offset)
    });
    if (state.query) parameters.set("q", state.query);
    if (state.month) parameters.set("month", state.month);
    if (state.tag) parameters.set("tag", state.tag);
    if (state.trash) parameters.set("trash", "1");

    try {
      const result = await api(`/entries?${parameters}`);
      if (requestId !== state.requestId) return;
      for (const entry of result.entries) {
        state.entries.push(entry);
        state.entryMap.set(entry.id, entry);
      }
      state.offset = state.entries.length;
      state.hasMore = result.hasMore;
      renderEntries();
      updateSearchStatus();
    } catch (error) {
      if (requestId !== state.requestId) return;
      elements.entryList.replaceChildren(createEmpty(error.message));
      elements.searchStatus.textContent = error.message;
    } finally {
      if (requestId === state.requestId) {
        elements.loadMore.hidden = !state.hasMore;
        setBusy(elements.loadMore, false, "さらに表示");
      }
    }
  }

  async function loadMeta() {
    try {
      const result = await api("/meta");
      renderArchive(result.months || []);
      renderTags(result.tags || []);
    } catch (error) {
      elements.archiveList.replaceChildren(createEmpty(error.message));
      elements.tagList.replaceChildren(createEmpty(error.message));
    }
  }

  function renderEntries() {
    if (!state.entries.length) {
      const message = state.trash
        ? "ゴミ箱は空です。"
        : state.query || state.month || state.tag
          ? "条件に合う日記はありません。"
          : "まだ日記はありません。";
      elements.entryList.replaceChildren(createEmpty(message));
      return;
    }

    elements.entryList.replaceChildren(...state.entries.map((entry) => {
      const article = document.createElement("article");
      article.className = "diary-entry-card";

      const button = document.createElement("button");
      button.className = "diary-entry-button";
      button.type = "button";
      button.dataset.entryId = String(entry.id);

      const time = document.createElement("time");
      time.dateTime = entry.entryDate;
      time.textContent = formatDate(entry.entryDate);
      const author = document.createElement("span");
      author.className = "entry-author";
      author.textContent = `投稿者：${entry.authorName}`;
      const meta = document.createElement("div");
      meta.className = "entry-meta";
      meta.append(time, author);
      if (state.trash && entry.deletedByName) {
        const deletedBy = document.createElement("span");
        deletedBy.className = "entry-author";
        deletedBy.textContent = `削除者：${entry.deletedByName}`;
        meta.append(deletedBy);
      }
      const title = document.createElement("h3");
      title.textContent = entry.title;
      const summary = document.createElement("p");
      summary.textContent = excerpt(entry.content, 130);
      button.append(meta, title, summary);
      article.append(button, createTagGroup(entry.tags));
      return article;
    }));
  }

  function renderArchive(months) {
    if (!months.length) {
      elements.archiveList.replaceChildren(createEmpty("年月別の記録はまだありません。"));
      return;
    }
    elements.archiveList.replaceChildren(...months.map((item) => {
      const button = document.createElement("button");
      button.className = "archive-button";
      button.type = "button";
      button.dataset.month = item.value;
      button.setAttribute("aria-pressed", String(state.month === item.value));
      const label = document.createElement("span");
      label.textContent = formatMonth(item.value);
      const count = document.createElement("small");
      count.textContent = `${item.count}件`;
      button.append(label, count);
      return button;
    }));
  }

  function renderTags(tags) {
    if (!tags.length) {
      elements.tagList.replaceChildren(createEmpty("#はまだありません。"));
      return;
    }
    elements.tagList.replaceChildren(...tags.map((item) => {
      const button = document.createElement("button");
      button.className = "diary-tag";
      button.type = "button";
      button.dataset.tag = item.value;
      button.setAttribute("aria-pressed", String(state.tag === item.value));
      button.textContent = `#${item.value} ${item.count}`;
      return button;
    }));
  }

  function handleEntryListClick(event) {
    const button = event.target.closest("[data-entry-id]");
    if (!button) return;
    openEntry(Number(button.dataset.entryId));
  }

  function handleArchiveClick(event) {
    const button = event.target.closest("[data-month]");
    if (!button) return;
    state.month = state.month === button.dataset.month ? "" : button.dataset.month;
    state.trash = false;
    updateFilterControls();
    loadEntries(true);
  }

  function handleTagClick(event) {
    const button = event.target.closest("[data-tag]");
    if (!button) return;
    state.tag = state.tag === button.dataset.tag ? "" : button.dataset.tag;
    state.trash = false;
    updateFilterControls();
    loadEntries(true);
  }

  async function openEntry(id) {
    try {
      const result = await api(`/entries/${id}`);
      state.activeEntry = result.entry;
      renderEntryDetail(result.entry);
      elements.entryDialog.showModal();
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderEntryDetail(entry) {
    elements.detailDate.textContent = formatDate(entry.entryDate);
    elements.detailTitle.textContent = entry.title;
    elements.detailAuthor.textContent = `投稿者：${entry.authorName}`;
    elements.detailDeletion.hidden = !entry.deletedAt || !entry.deletedByName;
    elements.detailDeletion.textContent = entry.deletedByName ? `削除者：${entry.deletedByName}` : "";
    elements.detailContent.textContent = entry.content;
    elements.detailTags.replaceChildren(...createTagElements(entry.tags));
    const isDeleted = Boolean(entry.deletedAt);
    elements.detailActions.hidden = state.role !== "admin" || isDeleted;
    elements.restoreActions.hidden = !state.canViewTrash || !isDeleted;
    elements.deleteEntryButton.textContent = state.canViewTrash ? "ゴミ箱へ移動" : "削除";
    elements.permanentlyDeleteEntryButton.hidden = !state.canPermanentlyDelete || !isDeleted;
  }

  function openEditor(entry = null) {
    if (state.role !== "admin") return;
    elements.editorMessage.textContent = "";
    elements.editorTitle.textContent = entry ? "日記を編集" : "新しい日記";
    elements.entryId.value = entry ? String(entry.id) : "";
    elements.entryRevision.value = entry ? String(entry.revision) : "";
    elements.entryDate.value = entry?.entryDate || japanDateString();
    elements.entryTitle.value = entry?.title || "";
    elements.entryContent.value = entry?.content || "";
    elements.entryTags.value = entry?.tags?.join("、") || "";
    state.editorDirty = false;
    elements.editorDialog.showModal();
    window.setTimeout(() => (entry ? elements.entryTitle : elements.entryTitle).focus(), 0);
  }

  async function saveEntry(event) {
    event.preventDefault();
    const id = Number(elements.entryId.value || 0);
    const body = {
      entryDate: elements.entryDate.value,
      title: elements.entryTitle.value,
      content: elements.entryContent.value,
      tags: parseTags(elements.entryTags.value)
    };
    if (id) body.revision = Number(elements.entryRevision.value);

    elements.editorMessage.textContent = "";
    setBusy(elements.saveEntryButton, true, "保存中...");
    try {
      await api(id ? `/entries/${id}` : "/entries", {
        method: id ? "PUT" : "POST",
        body
      });
      state.editorDirty = false;
      elements.editorDialog.close();
      showToast(id ? "日記を更新しました。" : "日記を保存しました。");
      state.trash = false;
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      elements.editorMessage.textContent = error.message;
    } finally {
      setBusy(elements.saveEntryButton, false, "保存");
    }
  }

  function handleDatePointerDown(event) {
    if (useMobileDateWheel()) {
      event.preventDefault();
      openDateWheel();
      return;
    }
    if (typeof elements.entryDate.showPicker === "function") {
      try {
        event.preventDefault();
        elements.entryDate.showPicker();
      } catch {
        // If the browser blocks showPicker, keep its standard date interaction available.
      }
    }
  }

  function handleDateKeydown(event) {
    if (!useMobileDateWheel() || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openDateWheel();
  }

  function useMobileDateWheel() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function setEntryDateToToday() {
    const today = japanDateString();
    if (elements.entryDate.value !== today) {
      elements.entryDate.value = today;
      elements.entryDate.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (elements.dateWheelDialog.open) {
      setDateDraft(today);
      renderDateWheel();
    }
  }

  function openDateWheel() {
    if (elements.dateWheelDialog.open) return;
    setDateDraft(elements.entryDate.value || japanDateString());
    renderDateWheel();
    elements.dateWheelDialog.showModal();
  }

  function closeDateWheel() {
    if (elements.dateWheelDialog.open) elements.dateWheelDialog.close();
  }

  function applyDateWheel() {
    if (!state.dateDraft) return closeDateWheel();
    const nextValue = datePartsToString(state.dateDraft);
    if (elements.entryDate.value !== nextValue) {
      elements.entryDate.value = nextValue;
      elements.entryDate.dispatchEvent(new Event("input", { bubbles: true }));
    }
    closeDateWheel();
  }

  function setDateDraft(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    state.dateDraft = {
      year: clamp(year || Number(japanDateString().slice(0, 4)), 1900, 2100),
      month: clamp(month || 1, 1, 12),
      day: day || 1
    };
    state.dateDraft.day = clamp(state.dateDraft.day, 1, daysInMonth(state.dateDraft.year, state.dateDraft.month));
  }

  function renderDateWheel() {
    if (!state.dateDraft) return;
    fillDateWheel(elements.dateWheelYear, range(1900, 2100), state.dateDraft.year, "年");
    fillDateWheel(elements.dateWheelMonth, range(1, 12), state.dateDraft.month, "月");
    renderDayWheel();
    updateDateWheelValue();
  }

  function renderDayWheel() {
    const maximum = daysInMonth(state.dateDraft.year, state.dateDraft.month);
    state.dateDraft.day = clamp(state.dateDraft.day, 1, maximum);
    fillDateWheel(elements.dateWheelDay, range(1, maximum), state.dateDraft.day, "日");
  }

  function fillDateWheel(column, values, selected, suffix) {
    column.replaceChildren(...values.map((value, index) => {
      const button = document.createElement("button");
      button.className = "date-wheel-option";
      button.type = "button";
      button.dataset.value = String(value);
      button.dataset.index = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(value === selected));
      button.textContent = `${value}${suffix}`;
      return button;
    }));
    const selectedIndex = Math.max(0, values.indexOf(selected));
    window.requestAnimationFrame(() => {
      column.scrollTop = selectedIndex * 44;
    });
  }

  function bindDateWheel(column, key) {
    column.addEventListener("click", (event) => {
      const option = event.target.closest(".date-wheel-option");
      if (!option) return;
      column.scrollTo({ top: Number(option.dataset.index) * 44, behavior: "smooth" });
    });
    column.addEventListener("scroll", () => {
      window.clearTimeout(state.dateWheelTimers[key]);
      state.dateWheelTimers[key] = window.setTimeout(() => updateDateWheelFromScroll(column, key), 80);
    }, { passive: true });
  }

  function updateDateWheelFromScroll(column, key) {
    const options = [...column.querySelectorAll(".date-wheel-option")];
    const index = clamp(Math.round(column.scrollTop / 44), 0, options.length - 1);
    const option = options[index];
    if (!option || !state.dateDraft) return;
    const value = Number(option.dataset.value);
    if (state.dateDraft[key] === value) return;
    state.dateDraft[key] = value;
    options.forEach((item, itemIndex) => item.setAttribute("aria-selected", String(itemIndex === index)));
    if (key === "year" || key === "month") renderDayWheel();
    updateDateWheelValue();
  }

  function updateDateWheelValue() {
    const { year, month, day } = state.dateDraft;
    elements.dateWheelValue.textContent = `${year}年${month}月${day}日`;
  }

  function datePartsToString({ year, month, day }) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function requestEntryDeletion() {
    if (!state.activeEntry) return;
    state.deleteMode = "trash";
    elements.deleteConfirmTitle.textContent = "本当に削除しますか？";
    elements.deleteConfirmMessage.textContent = state.canViewTrash
      ? `「${state.activeEntry.title}」をゴミ箱へ移動します。`
      : "";
    elements.deleteConfirmYes.textContent = "はい";
    elements.deleteConfirmDialog.showModal();
  }

  function requestPermanentDeletion() {
    if (!state.activeEntry || !state.canPermanentlyDelete || !state.activeEntry.deletedAt) return;
    state.deleteMode = "permanent";
    elements.deleteConfirmTitle.textContent = "本当に完全削除しますか？";
    elements.deleteConfirmMessage.textContent = "この操作は取り消せません。";
    elements.deleteConfirmYes.textContent = "完全に削除";
    elements.deleteConfirmDialog.showModal();
  }

  function closeDeleteConfirmation() {
    state.deleteMode = null;
    if (elements.deleteConfirmDialog.open) elements.deleteConfirmDialog.close();
  }

  async function confirmEntryDeletion() {
    const mode = state.deleteMode;
    closeDeleteConfirmation();
    if (mode === "permanent") await permanentlyDeleteActiveEntry();
    else if (mode === "trash") await moveActiveEntryToTrash();
  }

  async function moveActiveEntryToTrash() {
    const entry = state.activeEntry;
    if (!entry) return;
    const privateDeletion = !state.canViewTrash;
    setBusy(elements.deleteEntryButton, true, privateDeletion ? "削除中..." : "移動中...");
    try {
      await api(`/entries/${entry.id}`, {
        method: "DELETE",
        body: { revision: entry.revision }
      });
      elements.entryDialog.close();
      state.activeEntry = null;
      showToast(privateDeletion ? "削除しました。" : "日記をゴミ箱へ移動しました。");
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(elements.deleteEntryButton, false, privateDeletion ? "削除" : "ゴミ箱へ移動");
    }
  }

  async function permanentlyDeleteActiveEntry() {
    const entry = state.activeEntry;
    if (!entry || !state.canPermanentlyDelete || !entry.deletedAt) return;
    setBusy(elements.permanentlyDeleteEntryButton, true, "完全削除中...");
    try {
      await api(`/entries/${entry.id}/permanent`, {
        method: "DELETE",
        body: { revision: entry.revision }
      });
      elements.entryDialog.close();
      state.activeEntry = null;
      showToast("日記を完全に削除しました。");
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(elements.permanentlyDeleteEntryButton, false, "完全に削除");
    }
  }

  async function restoreActiveEntry() {
    const entry = state.activeEntry;
    if (!entry) return;
    setBusy(elements.restoreEntryButton, true, "復元中...");
    try {
      await api(`/entries/${entry.id}/restore`, { method: "POST" });
      elements.entryDialog.close();
      state.activeEntry = null;
      showToast("日記を復元しました。");
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(elements.restoreEntryButton, false, "日記を復元");
    }
  }

  function toggleTrash() {
    if (!state.canViewTrash) return;
    state.trash = !state.trash;
    state.query = "";
    state.month = "";
    state.tag = "";
    elements.searchInput.value = "";
    updateFilterControls();
    loadEntries(true);
  }

  function clearFilters() {
    state.query = "";
    state.month = "";
    state.tag = "";
    state.trash = false;
    elements.searchInput.value = "";
    updateFilterControls();
    loadEntries(true);
  }

  function updateFilterControls() {
    const active = Boolean(state.query || state.month || state.tag || state.trash);
    elements.searchClear.hidden = !state.query;
    elements.clearFilters.hidden = !active;
    elements.trashButton.textContent = state.trash ? "日記一覧" : "ゴミ箱";
    document.querySelectorAll("[data-month]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.month === state.month));
    });
    document.querySelectorAll("[data-tag]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.tag === state.tag));
    });
  }

  function updateListHeading() {
    if (state.trash) {
      elements.listKicker.textContent = "Trash";
      elements.listTitle.textContent = "ゴミ箱";
    } else if (state.query || state.month || state.tag) {
      elements.listKicker.textContent = "Results";
      elements.listTitle.textContent = "検索結果";
    } else {
      elements.listKicker.textContent = "Recent";
      elements.listTitle.textContent = "最近の更新";
    }
  }

  function updateSearchStatus() {
    const conditions = [];
    if (state.query) conditions.push(`「${state.query}」`);
    if (state.month) conditions.push(formatMonth(state.month));
    if (state.tag) conditions.push(`#${state.tag}`);
    if (state.trash) {
      elements.searchStatus.textContent = `${state.entries.length}件を表示しています。`;
    } else if (conditions.length) {
      elements.searchStatus.textContent = `${conditions.join("・")}：${state.entries.length}件を表示しています。`;
    } else {
      elements.searchStatus.textContent = `${state.entries.length}件の日記を表示しています。`;
    }
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog?.open) return;
    if (id === "editor-dialog" && state.editorDirty && !window.confirm("入力中の内容を破棄しますか？")) return;
    if (id === "editor-dialog") state.editorDirty = false;
    dialog.close();
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    const init = {
      method: options.method || "GET",
      headers,
      credentials: "same-origin"
    };
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    if (init.method !== "GET") headers.set("X-Diary-Request", "1");

    const response = await fetch(`${BASE_PATH}/api${path}`, init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== "/login") {
        resetState();
        showLogin("ログインの有効期限が切れました。");
      }
      throw new Error(result.error || "処理を完了できませんでした。");
    }
    return result;
  }

  function createTagGroup(tags) {
    const group = document.createElement("div");
    group.className = "diary-tags";
    group.append(...createTagElements(tags));
    return group;
  }

  function createTagElements(tags) {
    return (tags || []).map((tag) => {
      const span = document.createElement("span");
      span.className = "diary-tag";
      span.textContent = `#${tag}`;
      return span;
    });
  }

  function createEmpty(message) {
    const paragraph = document.createElement("p");
    paragraph.className = "diary-empty";
    paragraph.textContent = message;
    return paragraph;
  }

  function parseTags(value) {
    return [...new Set(String(value || "").split(/[、,，]/).map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))].slice(0, 10);
  }

  function formatDate(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!year || !month || !day) return value;
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    return `${year}年${month}月${day}日（${weekday}）`;
  }

  function formatMonth(value) {
    const [year, month] = String(value || "").split("-").map(Number);
    return year && month ? `${year}年${month}月` : value;
  }

  function excerpt(value, length) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function japanDateString() {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3500);
  }

  function resetState() {
    state.role = null;
    state.accountName = null;
    state.canViewTrash = false;
    state.canPermanentlyDelete = false;
    state.entries = [];
    state.entryMap.clear();
    state.offset = 0;
    state.hasMore = false;
    state.query = "";
    state.month = "";
    state.tag = "";
    state.trash = false;
    state.activeEntry = null;
    state.deleteMode = null;
    state.editorDirty = false;
    state.dateDraft = null;
    if (elements.dateWheelDialog.open) elements.dateWheelDialog.close();
    state.requestId += 1;
    if (elements.entryDialog.open) elements.entryDialog.close();
    if (elements.editorDialog.open) elements.editorDialog.close();
  }
})();

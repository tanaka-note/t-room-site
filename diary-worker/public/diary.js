(() => {
  const BASE_PATH = "/diary";
  const ENTRY_HISTORY_KEY = "troomDiaryEntry";
  const REMEMBER_LOGIN_KEY = "troom-diary-login-remember";
  const DATE_TAP_MAX_MOVEMENT_PX = 4;
  const DATE_TAP_MAX_DURATION_MS = 650;
  const HEADER_SCROLL_THRESHOLD_PX = 10;
  const datePointerGestures = new WeakMap();
  const tagCollator = new Intl.Collator(["ja-JP", "en-US"], {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true
  });
  const state = {
    role: null,
    accountName: null,
    householdId: null,
    activeHouseholdId: null,
    isGlobalOwner: false,
    mustChangePassword: false,
    pendingLoginId: "",
    canViewTrash: false,
    canPermanentlyDelete: false,
    canViewInvestment: false,
    entries: [],
    entryMap: new Map(),
    offset: 0,
    hasMore: false,
    query: "",
    month: japanDateString().slice(0, 7),
    monthExpanded: false,
    dateFrom: "",
    dateTo: "",
    tag: "",
    tagQuery: "",
    availableTags: [],
    trash: false,
    activeEntry: null,
    editorDirty: false,
    dateDraft: null,
    dateWheelTarget: null,
    dateWheelTimers: {},
    searchTimer: null,
    requestId: 0,
    deleteMode: null,
    editorPhotos: [],
    photoPreparing: false,
    photoOffset: 0,
    photos: [],
    photoHasMore: false,
    photoQuery: "",
    photoMonth: "",
    photoAuthor: "",
    photoRequestId: 0,
    photoSearchTimer: null,
    viewerPhotos: [],
    viewerIndex: -1,
    entryHistoryToken: null,
    entryAfterClose: null,
    entryClosePending: false,
    deferredInstallPrompt: null,
    lastSessionRefreshAt: 0,
    lastHeaderScrollY: 0,
    headerScrollFrame: 0
  };

  const elements = {
    bootView: document.querySelector("#boot-view"),
    loginView: document.querySelector("#login-view"),
    appView: document.querySelector("#app-view"),
    siteHeader: document.querySelector("#site-header"),
    loginForm: document.querySelector("#login-form"),
    loginId: document.querySelector("#login-id"),
    password: document.querySelector("#password"),
    passwordToggle: document.querySelector("#password-toggle"),
    rememberLogin: document.querySelector("#remember-login"),
    loginMessage: document.querySelector("#login-message"),
    initialPasswordDialog: document.querySelector("#initial-password-dialog"),
    initialPasswordForm: document.querySelector("#initial-password-form"),
    initialPassword: document.querySelector("#initial-password"),
    initialPasswordConfirmation: document.querySelector("#initial-password-confirmation"),
    initialPasswordMessage: document.querySelector("#initial-password-message"),
    initialPasswordSubmit: document.querySelector("#initial-password-submit"),
    initialPasswordCancel: document.querySelector("#initial-password-cancel"),
    diaryKicker: document.querySelector("#diary-kicker"),
    diaryTitle: document.querySelector("#diary-title"),
    tagPageBack: document.querySelector("#tag-page-back"),
    searchPanel: document.querySelector("#diary-search-panel"),
    roleLabel: document.querySelector("#role-label"),
    householdSwitcherWrap: document.querySelector("#household-switcher-wrap"),
    householdSwitcher: document.querySelector("#household-switcher"),
    cameraRollButton: document.querySelector("#camera-roll-button"),
    newEntryButton: document.querySelector("#new-entry-button"),
    trashButton: document.querySelector("#trash-button"),
    logoutButton: document.querySelector("#logout-button"),
    investmentSection: document.querySelector("#investment-section"),
    installButtons: [...document.querySelectorAll(".install-app-button")],
    installAppDialog: document.querySelector("#install-app-dialog"),
    installAppMessage: document.querySelector("#install-app-message"),
    searchInput: document.querySelector("#diary-search-input"),
    searchClear: document.querySelector("#diary-search-clear"),
    searchStatus: document.querySelector("#diary-search-status"),
    dateFrom: document.querySelector("#diary-date-from"),
    dateTo: document.querySelector("#diary-date-to"),
    dateReset: document.querySelector("#diary-date-reset"),
    clearFilters: document.querySelector("#clear-filters-button"),
    listKicker: document.querySelector("#list-kicker"),
    listTitle: document.querySelector("#diary-recent-title"),
    entryList: document.querySelector("#entry-list"),
    loadMore: document.querySelector("#load-more-button"),
    monthNavigation: document.querySelector("#month-navigation"),
    previousMonth: document.querySelector("#previous-month-button"),
    nextMonth: document.querySelector("#next-month-button"),
    archiveList: document.querySelector("#archive-list"),
    tagList: document.querySelector("#tag-list"),
    tagSearchInput: document.querySelector("#tag-search-input"),
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
    addPhotoButton: document.querySelector("#add-photo-button"),
    photoInput: document.querySelector("#photo-input"),
    photoDropZone: document.querySelector("#photo-drop-zone"),
    editorPhotoList: document.querySelector("#editor-photo-list"),
    photoPreparationStatus: document.querySelector("#photo-preparation-status"),
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
    cameraRollDialog: document.querySelector("#camera-roll-dialog"),
    photoSearch: document.querySelector("#photo-search"),
    photoMonthFilter: document.querySelector("#photo-month-filter"),
    photoAuthorFilter: document.querySelector("#photo-author-filter"),
    cameraRollStatus: document.querySelector("#camera-roll-status"),
    cameraRollGrid: document.querySelector("#camera-roll-grid"),
    cameraRollMore: document.querySelector("#camera-roll-more"),
    photoViewerDialog: document.querySelector("#photo-viewer-dialog"),
    photoViewerDate: document.querySelector("#photo-viewer-date"),
    photoViewerTitle: document.querySelector("#photo-viewer-title"),
    photoViewerImage: document.querySelector("#photo-viewer-image"),
    photoViewerFile: document.querySelector("#photo-viewer-file"),
    photoPrevious: document.querySelector("#photo-previous"),
    photoNext: document.querySelector("#photo-next"),
    photoOpenEntry: document.querySelector("#photo-open-entry"),
    photoDownloadLow: document.querySelector("#photo-download-low"),
    photoDownloadOriginal: document.querySelector("#photo-download-original"),
    toast: document.querySelector("#toast")
  };

  boot();

  async function boot() {
    applyRouteState();
    bindEvents();
    restoreRememberedLogin();
    registerPwa();
    updateInstallButtonVisibility();
    try {
      const session = await api("/session");
      if (session.authenticated) {
        if (session.mustChangePassword) await showInitialPasswordSetup(session);
        else await enterDiary(session);
      } else {
        showLogin();
      }
    } catch (error) {
      showLogin(error.message);
    }
  }

  function bindEvents() {
    window.addEventListener("scroll", scheduleHeaderVisibilityUpdate, { passive: true });
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.rememberLogin.addEventListener("change", syncLoginAutocomplete);
    elements.passwordToggle.addEventListener("click", togglePassword);
    elements.initialPasswordForm.addEventListener("submit", handleInitialPasswordChange);
    elements.initialPasswordCancel.addEventListener("click", leaveInitialPasswordSetup);
    elements.initialPasswordDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      leaveInitialPasswordSetup();
    });
    document.querySelectorAll("[data-password-toggle]").forEach((button) => {
      button.addEventListener("click", () => togglePasswordField(button.dataset.passwordToggle, button));
    });
    elements.householdSwitcher.addEventListener("change", changeActiveHousehold);
    elements.logoutButton.addEventListener("click", handleLogout);
    elements.installButtons.forEach((button) => button.addEventListener("click", requestAppInstall));
    elements.cameraRollButton.addEventListener("click", openCameraRoll);
    elements.newEntryButton.addEventListener("click", () => openEditor());
    elements.trashButton.addEventListener("click", toggleTrash);
    elements.loadMore.addEventListener("click", handleLoadMore);
    elements.previousMonth.addEventListener("click", () => changeBrowseMonth(-1));
    elements.nextMonth.addEventListener("click", () => changeBrowseMonth(1));
    elements.clearFilters.addEventListener("click", clearFilters);
    elements.dateReset.addEventListener("click", resetDateSearch);
    elements.searchClear.addEventListener("click", () => {
      elements.searchInput.value = "";
      state.query = "";
      state.monthExpanded = false;
      updateFilterControls();
      loadEntries(true);
      elements.searchInput.focus();
    });
    elements.searchInput.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.query = elements.searchInput.value.trim();
      state.monthExpanded = false;
      updateFilterControls();
      state.searchTimer = window.setTimeout(() => loadEntries(true), 300);
    });
    for (const input of [elements.dateFrom, elements.dateTo]) {
      bindDateInput(input);
      input.addEventListener("change", handleDateSearchChange);
    }
    elements.tagSearchInput.addEventListener("input", () => {
      state.tagQuery = elements.tagSearchInput.value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
      renderTags(state.availableTags);
    });
    elements.entryList.addEventListener("click", handleEntryListClick);
    elements.archiveList.addEventListener("click", handleArchiveClick);
    elements.editEntryButton.addEventListener("click", () => {
      if (state.activeEntry) {
        const entry = state.activeEntry;
        closeEntryDialog(() => openEditor(entry));
      }
    });
    elements.entryDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeEntryDialog();
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
    elements.addPhotoButton.addEventListener("click", () => elements.photoInput.click());
    elements.photoInput.addEventListener("change", handlePhotoSelection);
    elements.photoDropZone.addEventListener("click", () => {
      if (!state.photoPreparing) elements.photoInput.click();
    });
    elements.photoDropZone.addEventListener("keydown", handlePhotoDropKeydown);
    for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
      elements.photoDropZone.addEventListener(eventName, handlePhotoDragEvent);
    }
    elements.editorPhotoList.addEventListener("click", handleEditorPhotoAction);
    elements.todayButton.addEventListener("click", setEntryDateToToday);
    bindDateInput(elements.entryDate);
    elements.dateWheelCancel.addEventListener("click", closeDateWheel);
    elements.dateWheelDone.addEventListener("click", applyDateWheel);
    elements.dateWheelDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDateWheel();
    });
    elements.dateWheelDialog.addEventListener("click", closeDateWheelFromBackdrop);
    bindDateWheel(elements.dateWheelYear, "year");
    bindDateWheel(elements.dateWheelMonth, "month");
    bindDateWheel(elements.dateWheelDay, "day");
    elements.entryForm.addEventListener("input", () => {
      state.editorDirty = true;
    });
    elements.cameraRollMore.addEventListener("click", () => loadPhotos(false));
    elements.cameraRollGrid.addEventListener("click", handleCameraRollClick);
    elements.photoMonthFilter.addEventListener("change", () => {
      state.photoMonth = elements.photoMonthFilter.value;
      loadPhotos(true);
    });
    elements.photoAuthorFilter.addEventListener("change", () => {
      state.photoAuthor = elements.photoAuthorFilter.value;
      loadPhotos(true);
    });
    elements.photoSearch.addEventListener("input", () => {
      window.clearTimeout(state.photoSearchTimer);
      state.photoQuery = elements.photoSearch.value.trim();
      state.photoSearchTimer = window.setTimeout(() => loadPhotos(true), 300);
    });
    elements.photoPrevious.addEventListener("click", () => movePhotoViewer(-1));
    elements.photoNext.addEventListener("click", () => movePhotoViewer(1));
    elements.photoOpenEntry.addEventListener("click", openViewerEntry);
    elements.photoViewerDialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") movePhotoViewer(-1);
      if (event.key === "ArrowRight") movePhotoViewer(1);
    });

    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
    });
    elements.editorDialog.addEventListener("cancel", (event) => {
      if (state.editorDirty && !window.confirm("入力中の内容を破棄しますか？")) event.preventDefault();
      else {
        state.editorDirty = false;
        clearEditorPhotos();
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (!state.editorDirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
    window.addEventListener("popstate", handleHistoryNavigation);
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      updateInstallButtonVisibility();
    });
    window.addEventListener("appinstalled", () => {
      state.deferredInstallPrompt = null;
      updateInstallButtonVisibility();
      showToast("日記をホーム画面に追加しました。");
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshSessionIfNeeded();
    });
  }

  function scheduleHeaderVisibilityUpdate() {
    if (state.headerScrollFrame) return;
    state.headerScrollFrame = window.requestAnimationFrame(updateHeaderVisibility);
  }

  function updateHeaderVisibility() {
    state.headerScrollFrame = 0;
    const currentY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    const movement = currentY - state.lastHeaderScrollY;
    const focusedInsideHeader = elements.siteHeader?.contains(document.activeElement);

    if (currentY <= HEADER_SCROLL_THRESHOLD_PX || movement < -HEADER_SCROLL_THRESHOLD_PX || focusedInsideHeader) {
      elements.siteHeader?.classList.remove("is-scroll-hidden");
    } else if (movement > HEADER_SCROLL_THRESHOLD_PX) {
      elements.siteHeader?.classList.add("is-scroll-hidden");
    }

    if (Math.abs(movement) > HEADER_SCROLL_THRESHOLD_PX || currentY <= HEADER_SCROLL_THRESHOLD_PX) {
      state.lastHeaderScrollY = currentY;
    }
  }

  function registerPwa() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${BASE_PATH}/service-worker.js`, {
      scope: `${BASE_PATH}/`,
      updateViaCache: "none"
    }).then((registration) => registration.update()).catch(() => {
      // Safariの古い版など、Service Worker非対応環境でも日記本体は利用できます。
    });
  }

  function isStandaloneApp() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function updateInstallButtonVisibility() {
    const hidden = isStandaloneApp();
    elements.installButtons.forEach((button) => {
      button.hidden = hidden;
    });
  }

  async function requestAppInstall() {
    if (state.deferredInstallPrompt) {
      const prompt = state.deferredInstallPrompt;
      state.deferredInstallPrompt = null;
      await prompt.prompt();
      await prompt.userChoice.catch(() => null);
      updateInstallButtonVisibility();
      return;
    }
    elements.installAppDialog.showModal();
  }

  async function refreshSessionIfNeeded() {
    if (!state.role || Date.now() - state.lastSessionRefreshAt < 15 * 60 * 1000) return;
    try {
      const session = await api("/session");
      if (session.authenticated) state.lastSessionRefreshAt = Date.now();
    } catch {
      // 期限切れの場合はapi()がログイン画面へ戻します。
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const submit = elements.loginForm.querySelector('button[type="submit"]');
    setBusy(submit, true, "確認中...");
    elements.loginMessage.textContent = "";
    try {
      const loginId = elements.loginId.value.trim().toLowerCase();
      const password = elements.password.value;
      const result = await api("/login", {
        method: "POST",
        body: { loginId, password }
      });
      elements.password.value = "";
      if (result.mustChangePassword) {
        state.pendingLoginId = loginId;
        await showInitialPasswordSetup(result);
      } else {
        await updateRememberedLogin(loginId, password);
        await enterDiary(result);
      }
    } catch (error) {
      elements.loginMessage.textContent = error.message;
      elements.password.select();
    } finally {
      setBusy(submit, false, "開く");
    }
  }

  function restoreRememberedLogin() {
    elements.rememberLogin.checked = localStorage.getItem(REMEMBER_LOGIN_KEY) === "1";
    syncLoginAutocomplete();
  }

  function syncLoginAutocomplete() {
    const remember = elements.rememberLogin.checked;
    elements.loginId.setAttribute("autocomplete", remember ? "username" : "off");
    elements.password.setAttribute("autocomplete", remember ? "current-password" : "off");
  }

  async function updateRememberedLogin(loginId, password) {
    if (!elements.rememberLogin.checked) {
      localStorage.removeItem(REMEMBER_LOGIN_KEY);
      return;
    }
    localStorage.setItem(REMEMBER_LOGIN_KEY, "1");
    if (!navigator.credentials?.store || !globalThis.PasswordCredential) return;
    try {
      await navigator.credentials.store(new PasswordCredential({ id: loginId, password, name: "日記" }));
    } catch {
      // 保存可否はブラウザのパスワード管理機能へ委ねる。
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
    togglePasswordField("password", elements.passwordToggle);
  }

  function togglePasswordField(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    const label = show ? "パスワードを隠す" : "パスワードを表示";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", String(show));
  }

  async function showInitialPasswordSetup(session) {
    state.role = session.role;
    state.accountName = session.accountName;
    state.mustChangePassword = true;
    elements.bootView.hidden = true;
    elements.loginView.hidden = true;
    elements.appView.hidden = true;
    elements.initialPasswordForm.reset();
    elements.initialPasswordMessage.textContent = "";
    if (!elements.initialPasswordDialog.open) elements.initialPasswordDialog.showModal();
    window.setTimeout(() => elements.initialPassword.focus(), 0);
  }

  async function handleInitialPasswordChange(event) {
    event.preventDefault();
    const password = elements.initialPassword.value;
    const confirmation = elements.initialPasswordConfirmation.value;
    elements.initialPasswordMessage.textContent = "";
    if (password !== confirmation) {
      elements.initialPasswordMessage.textContent = "確認用パスワードが一致しません。";
      elements.initialPasswordConfirmation.focus();
      return;
    }
    setBusy(elements.initialPasswordSubmit, true, "設定中…");
    try {
      const session = await api("/password/initial", { method: "POST", body: { password, confirmation } });
      await updateRememberedLogin(state.pendingLoginId || elements.loginId.value.trim().toLowerCase(), password);
      state.pendingLoginId = "";
      elements.initialPasswordForm.reset();
      elements.initialPasswordDialog.close();
      await enterDiary(session);
      showToast("新しいパスワードを設定しました。");
    } catch (error) {
      elements.initialPasswordMessage.textContent = error.message;
    } finally {
      setBusy(elements.initialPasswordSubmit, false, "パスワードを設定");
    }
  }

  async function leaveInitialPasswordSetup() {
    elements.initialPasswordCancel.disabled = true;
    try {
      await api("/logout", { method: "POST" });
    } catch {
      // ログアウト応答に失敗しても、初回設定画面から安全に戻します。
    }
    resetState();
    showLogin();
    elements.initialPasswordCancel.disabled = false;
  }

  async function enterDiary(session) {
    state.role = session.role;
    state.accountName = session.accountName;
    state.householdId = session.householdId;
    state.activeHouseholdId = session.activeHouseholdId || session.householdId;
    state.isGlobalOwner = Boolean(session.isGlobalOwner);
    state.mustChangePassword = false;
    state.pendingLoginId = "";
    state.canViewTrash = Boolean(session.canViewTrash);
    state.canPermanentlyDelete = Boolean(session.canPermanentlyDelete);
    state.canViewInvestment = Boolean(session.canViewInvestment);
    state.lastSessionRefreshAt = Date.now();
    elements.bootView.hidden = true;
    elements.loginView.hidden = true;
    elements.appView.hidden = false;
    elements.roleLabel.textContent = `${session.accountName}（管理者）`;
    elements.newEntryButton.hidden = session.role !== "admin";
    elements.trashButton.hidden = !state.canViewTrash;
    elements.investmentSection.hidden = !state.canViewInvestment;
    updateFilterControls();
    await loadHouseholdSwitcher();
    await Promise.all([loadMeta(), loadEntries(true)]);
  }

  async function loadHouseholdSwitcher() {
    elements.householdSwitcherWrap.hidden = !state.isGlobalOwner;
    if (!state.isGlobalOwner) return;
    const result = await api("/households");
    elements.householdSwitcher.replaceChildren(...result.households.map((household) => {
      const option = document.createElement("option");
      option.value = household.id;
      option.textContent = household.name;
      option.selected = household.id === result.activeHouseholdId;
      return option;
    }));
  }

  async function changeActiveHousehold() {
    const householdId = elements.householdSwitcher.value;
    elements.householdSwitcher.disabled = true;
    try {
      await api("/households/select", { method: "POST", body: { householdId } });
      state.activeHouseholdId = householdId;
      state.trash = false;
      state.query = "";
      state.month = currentJapanMonth();
      state.monthExpanded = false;
      state.dateFrom = "";
      state.dateTo = "";
      state.tag = "";
      state.tagQuery = "";
      elements.dateFrom.value = "";
      elements.dateTo.value = "";
      elements.tagSearchInput.value = "";
      updateFilterControls();
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      showToast(error.message);
      await loadHouseholdSwitcher();
    } finally {
      elements.householdSwitcher.disabled = false;
    }
  }

  function showLogin(message = "") {
    if (elements.initialPasswordDialog.open) elements.initialPasswordDialog.close();
    elements.bootView.hidden = true;
    elements.loginView.hidden = false;
    elements.appView.hidden = true;
    elements.loginMessage.textContent = message;
    window.setTimeout(() => (elements.loginId.value ? elements.password : elements.loginId).focus(), 0);
  }

  async function loadEntries(reset) {
    const requestId = ++state.requestId;
    const monthlyView = isMonthlyView();
    const pageSize = monthlyView ? (state.monthExpanded ? 50 : 5) : 20;
    const loadedEntries = reset ? [] : [...state.entries];
    let nextOffset = reset ? 0 : state.offset;
    let hasMore = true;
    let pageGuard = 0;
    if (reset) {
      state.offset = 0;
      state.entries = [];
      state.entryMap.clear();
      elements.entryList.replaceChildren(createEmpty("読み込んでいます..."));
    }
    setBusy(elements.loadMore, true, "読み込んでいます...");
    updateListHeading();

    try {
      do {
        const parameters = new URLSearchParams({
          limit: String(pageSize),
          offset: String(nextOffset)
        });
        if (state.query) parameters.set("q", state.query);
        if (monthlyView) parameters.set("month", state.month);
        if (state.dateFrom) parameters.set("dateFrom", state.dateFrom);
        if (state.dateTo) parameters.set("dateTo", state.dateTo);
        if (state.tag) parameters.set("tag", state.tag);
        if (state.trash) parameters.set("trash", "1");

        const result = await api(`/entries?${parameters}`);
        if (requestId !== state.requestId) return;
        loadedEntries.push(...result.entries);
        nextOffset += result.entries.length;
        hasMore = result.hasMore;
        pageGuard += 1;
      } while (monthlyView && state.monthExpanded && hasMore && pageGuard < 100);

      state.entries = loadedEntries;
      state.entryMap.clear();
      for (const entry of state.entries) state.entryMap.set(entry.id, entry);
      state.offset = state.entries.length;
      state.hasMore = hasMore;
      renderEntries();
      updateSearchStatus();
    } catch (error) {
      if (requestId !== state.requestId) return;
      elements.entryList.replaceChildren(createEmpty(error.message));
      elements.searchStatus.textContent = error.message;
    } finally {
      if (requestId === state.requestId) {
        elements.loadMore.hidden = monthlyView ? state.monthExpanded || !state.hasMore : !state.hasMore;
        setBusy(elements.loadMore, false, monthlyView ? "もっと見る" : "さらに表示");
      }
    }
  }

  function handleLoadMore() {
    if (isMonthlyView()) {
      state.monthExpanded = true;
      loadEntries(true);
      return;
    }
    loadEntries(false);
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
        : isMonthlyView()
          ? "記事なし"
          : state.query || state.dateFrom || state.dateTo || state.tag
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
    state.availableTags = [...tags];
    const filteredTags = state.tagQuery
      ? tags.filter((item) => String(item.value || "").normalize("NFKC").toLocaleLowerCase("ja-JP").includes(state.tagQuery))
      : tags;
    if (!filteredTags.length) {
      elements.tagList.replaceChildren(createEmpty(state.tagQuery ? "一致するタグはありません。" : "#はまだありません。"));
      return;
    }
    const sortedTags = [...filteredTags].sort((left, right) => (
      Number(right.count || 0) - Number(left.count || 0)
      || tagCollator.compare(tagSortKey(left.value), tagSortKey(right.value))
      || tagCollator.compare(String(left.value || ""), String(right.value || ""))
    ));
    elements.tagList.replaceChildren(...sortedTags.map((item) => {
      const link = createTagLink(item.value, `#${item.value} ${item.count}`);
      if (state.tag === item.value) link.setAttribute("aria-current", "page");
      return link;
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
    state.month = button.dataset.month;
    state.monthExpanded = false;
    state.query = "";
    state.dateFrom = "";
    state.dateTo = "";
    state.tag = "";
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    elements.searchInput.value = "";
    state.trash = false;
    if (window.location.pathname !== `${BASE_PATH}/`) {
      window.history.replaceState({}, "", `${BASE_PATH}/`);
      applyRouteState();
    }
    updateFilterControls();
    loadEntries(true);
  }

  async function openEntry(id) {
    try {
      const result = await api(`/entries/${id}`);
      state.activeEntry = result.entry;
      renderEntryDetail(result.entry);
      elements.entryDialog.showModal();
      pushEntryHistory();
    } catch (error) {
      showToast(error.message);
    }
  }

  function pushEntryHistory() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.entryHistoryToken = token;
    state.entryClosePending = false;
    window.history.pushState({
      ...(window.history.state || {}),
      [ENTRY_HISTORY_KEY]: token
    }, "", window.location.href);
  }

  function closeEntryDialog(afterClose = null) {
    if (typeof afterClose === "function") state.entryAfterClose = afterClose;
    if (state.entryClosePending) return;
    if (!elements.entryDialog.open) {
      finishEntryClose();
      return;
    }
    if (
      state.entryHistoryToken
      && window.history.state?.[ENTRY_HISTORY_KEY] === state.entryHistoryToken
    ) {
      state.entryClosePending = true;
      window.history.back();
      return;
    }
    finishEntryClose();
  }

  function handleHistoryNavigation() {
    if (!state.entryHistoryToken || !elements.entryDialog.open) return;
    finishEntryClose();
  }

  function finishEntryClose() {
    const afterClose = state.entryAfterClose;
    state.entryAfterClose = null;
    state.entryHistoryToken = null;
    state.entryClosePending = false;
    if (elements.entryDialog.open) elements.entryDialog.close();
    state.activeEntry = null;
    if (afterClose) afterClose();
  }

  function renderEntryDetail(entry) {
    elements.detailDate.textContent = formatDate(entry.entryDate);
    elements.detailTitle.textContent = entry.title;
    elements.detailAuthor.textContent = `投稿者：${entry.authorName}`;
    elements.detailDeletion.hidden = !entry.deletedAt || !entry.deletedByName;
    elements.detailDeletion.textContent = entry.deletedByName ? `削除者：${entry.deletedByName}` : "";
    renderEntryContent(entry);
    elements.detailTags.replaceChildren(...createTagElements(entry.tags));
    const isDeleted = Boolean(entry.deletedAt);
    elements.detailActions.hidden = state.role !== "admin" || isDeleted;
    elements.restoreActions.hidden = !state.canViewTrash || !isDeleted;
    elements.deleteEntryButton.textContent = state.canViewTrash ? "ゴミ箱へ移動" : "削除";
    elements.permanentlyDeleteEntryButton.hidden = !state.canPermanentlyDelete || !isDeleted;
  }

  function renderEntryContent(entry) {
    const photos = new Map((entry.photos || []).map((photo) => [photo.id, photo]));
    const rendered = new Set();
    const fragment = document.createDocumentFragment();
    const markerPattern = /\[\[写真:([0-9a-f-]{36})\]\]/gi;
    let cursor = 0;
    let match;
    while ((match = markerPattern.exec(entry.content)) !== null) {
      appendEntryText(fragment, entry.content.slice(cursor, match.index));
      const photo = photos.get(match[1].toLowerCase());
      if (photo) {
        fragment.append(createEntryPhoto(photo, entry.photos));
        rendered.add(photo.id);
      }
      cursor = match.index + match[0].length;
    }
    appendEntryText(fragment, entry.content.slice(cursor));
    for (const photo of entry.photos || []) {
      if (!rendered.has(photo.id)) fragment.append(createEntryPhoto(photo, entry.photos));
    }
    elements.detailContent.replaceChildren(fragment);
  }

  function appendEntryText(fragment, text) {
    if (!text) return;
    const span = document.createElement("span");
    span.className = "entry-content-text";
    span.textContent = text;
    fragment.append(span);
  }

  function createEntryPhoto(photo, photos) {
    const image = document.createElement("img");
    image.className = "entry-photo";
    image.src = photo.displayUrl;
    image.alt = photo.fileName || "日記の写真";
    image.loading = "lazy";
    image.addEventListener("click", () => openPhotoViewer(photos, photos.findIndex((candidate) => candidate.id === photo.id)));
    return image;
  }

  async function handlePhotoSelection() {
    const files = [...(elements.photoInput.files || [])];
    elements.photoInput.value = "";
    await prepareSelectedPhotos(files);
  }

  function handlePhotoDropKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!state.photoPreparing) elements.photoInput.click();
  }

  function handlePhotoDragEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragenter" || event.type === "dragover") {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (!state.photoPreparing) elements.photoDropZone.classList.add("is-dragging");
      return;
    }
    if (event.type === "dragleave") {
      if (!event.relatedTarget || !elements.photoDropZone.contains(event.relatedTarget)) {
        elements.photoDropZone.classList.remove("is-dragging");
      }
      return;
    }
    elements.photoDropZone.classList.remove("is-dragging");
    if (state.photoPreparing) {
      elements.photoPreparationStatus.textContent = "画像を準備中です。完了してから追加してください。";
      return;
    }
    prepareSelectedPhotos([...(event.dataTransfer?.files || [])]);
  }

  async function prepareSelectedPhotos(files) {
    if (!files.length) return;
    if (state.photoPreparing) return;
    state.photoPreparing = true;
    elements.photoInput.disabled = true;
    elements.photoDropZone.classList.add("is-busy");
    elements.photoDropZone.setAttribute("aria-disabled", "true");
    setBusy(elements.addPhotoButton, true, "準備中...");
    elements.photoPreparationStatus.textContent = `${files.length}件の写真を準備しています。`;
    const failures = [];
    let preparedCount = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        elements.photoPreparationStatus.textContent = `写真を準備中 ${index + 1}/${files.length}`;
        try {
          const photo = await preparePhoto(file);
          state.editorPhotos.push(photo);
          insertPhotoMarker(photo.id);
          preparedCount += 1;
        } catch (error) {
          failures.push(`${file.name}：${error.message}`);
        }
      }
      state.editorDirty = true;
      renderEditorPhotos();
      elements.photoPreparationStatus.textContent = failures.length
        ? `${preparedCount}件を追加しました。追加できなかったファイル：${failures.join(" / ")}`
        : `${preparedCount}件の写真を本文へ追加しました。`;
    } finally {
      state.photoPreparing = false;
      elements.photoInput.disabled = false;
      elements.photoDropZone.classList.remove("is-busy", "is-dragging");
      elements.photoDropZone.removeAttribute("aria-disabled");
      setBusy(elements.addPhotoButton, false, "写真を追加");
    }
  }

  async function preparePhoto(file) {
    if (!(file instanceof File) || !String(file.type).startsWith("image/")) {
      throw new Error("画像ファイルではありません。");
    }
    if (!file.size || file.size > 60 * 1024 * 1024) throw new Error("60MB以内の画像を選択してください。");
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("この画像形式をブラウザで読み取れませんでした。");
    }
    try {
      const [displayBlob, thumbnailBlob] = await Promise.all([
        resizePhoto(bitmap, 1800, 320 * 1024, 0.88),
        resizePhoto(bitmap, 480, 100 * 1024, 0.82)
      ]);
      const id = crypto.randomUUID().toLowerCase();
      return {
        id,
        fileName: file.name || "photo",
        originalFile: file,
        displayBlob,
        thumbnailBlob,
        width: bitmap.width,
        height: bitmap.height,
        previewUrl: URL.createObjectURL(thumbnailBlob),
        existing: false
      };
    } finally {
      bitmap.close();
    }
  }

  async function resizePhoto(bitmap, maxDimension, targetBytes, initialQuality) {
    const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    let quality = initialQuality;
    let blob = await canvasToBlob(canvas, quality);
    while (blob.size > targetBytes && quality > 0.5) {
      quality -= 0.08;
      blob = await canvasToBlob(canvas, quality);
    }
    return blob;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を変換できませんでした。")), "image/webp", quality);
    });
  }

  function insertPhotoMarker(id) {
    const marker = photoMarker(id);
    const textarea = elements.entryContent;
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const prefix = start > 0 && textarea.value[start - 1] !== "\n" ? "\n" : "";
    const suffix = end < textarea.value.length && textarea.value[end] !== "\n" ? "\n" : "";
    textarea.setRangeText(`${prefix}${marker}${suffix}`, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function photoMarker(id) {
    return `[[写真:${id}]]`;
  }

  function renderEditorPhotos() {
    elements.editorPhotoList.replaceChildren(...state.editorPhotos.map((photo) => {
      const card = document.createElement("article");
      card.className = "editor-photo-card";
      const image = document.createElement("img");
      image.src = photo.thumbnailUrl || photo.previewUrl;
      image.alt = photo.fileName;
      const body = document.createElement("div");
      body.className = "editor-photo-card-body";
      const name = document.createElement("p");
      name.className = "editor-photo-card-name";
      name.textContent = photo.fileName;
      const actions = document.createElement("div");
      actions.className = "editor-photo-card-actions";
      const markerPresent = elements.entryContent.value.includes(photoMarker(photo.id));
      const insert = document.createElement("button");
      insert.className = "quiet-button";
      insert.type = "button";
      insert.dataset.photoAction = "insert";
      insert.dataset.photoId = photo.id;
      insert.textContent = markerPresent ? "挿入済み" : "本文へ挿入";
      insert.disabled = markerPresent;
      actions.append(insert);
      if (!photo.existing) {
        const remove = document.createElement("button");
        remove.className = "danger-button";
        remove.type = "button";
        remove.dataset.photoAction = "remove";
        remove.dataset.photoId = photo.id;
        remove.textContent = "取り除く";
        actions.append(remove);
      }
      body.append(name, actions);
      card.append(image, body);
      return card;
    }));
  }

  function handleEditorPhotoAction(event) {
    const button = event.target.closest("[data-photo-action]");
    if (!button) return;
    const photo = state.editorPhotos.find((candidate) => candidate.id === button.dataset.photoId);
    if (!photo) return;
    if (button.dataset.photoAction === "insert") {
      insertPhotoMarker(photo.id);
      renderEditorPhotos();
      return;
    }
    if (button.dataset.photoAction === "remove" && !photo.existing) {
      elements.entryContent.value = elements.entryContent.value.replaceAll(photoMarker(photo.id), "").replace(/\n{3,}/g, "\n\n");
      if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
      state.editorPhotos = state.editorPhotos.filter((candidate) => candidate.id !== photo.id);
      state.editorDirty = true;
      renderEditorPhotos();
    }
  }

  function clearEditorPhotos() {
    for (const photo of state.editorPhotos) {
      if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    }
    state.editorPhotos = [];
    elements.editorPhotoList?.replaceChildren();
  }

  async function uploadPhoto(entryId, photo) {
    const form = new FormData();
    form.set("id", photo.id);
    form.set("width", String(photo.width || ""));
    form.set("height", String(photo.height || ""));
    form.set("original", photo.originalFile, photo.fileName);
    form.set("display", photo.displayBlob, "display.webp");
    form.set("thumbnail", photo.thumbnailBlob, "thumbnail.webp");
    const response = await fetch(`${BASE_PATH}/api/entries/${entryId}/photos`, {
      method: "POST",
      headers: { "X-Diary-Request": "1" },
      credentials: "same-origin",
      body: form
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "画像を保存できませんでした。");
    return result;
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
    clearEditorPhotos();
    state.editorPhotos = (entry?.photos || []).map((photo) => ({ ...photo, existing: true }));
    elements.photoPreparationStatus.textContent = "";
    renderEditorPhotos();
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
      const saved = await api(id ? `/entries/${id}` : "/entries", {
        method: id ? "PUT" : "POST",
        body
      });
      const pendingPhotos = state.editorPhotos.filter((photo) => !photo.existing && body.content.includes(photoMarker(photo.id)));
      const failures = [];
      for (let index = 0; index < pendingPhotos.length; index += 1) {
        const photo = pendingPhotos[index];
        setBusy(elements.saveEntryButton, true, `写真を保存中 ${index + 1}/${pendingPhotos.length}`);
        try {
          const result = await uploadPhoto(saved.entry.id, photo);
          photo.existing = true;
          Object.assign(photo, result.photo);
        } catch (error) {
          failures.push(`${photo.fileName}：${error.message}`);
        }
      }
      if (failures.length) {
        elements.entryId.value = String(saved.entry.id);
        elements.entryRevision.value = String(saved.entry.revision);
        elements.editorMessage.textContent = `日記本文は保存しました。写真を保存できませんでした。${failures.join(" / ")}`;
        renderEditorPhotos();
        return;
      }
      state.editorDirty = false;
      clearEditorPhotos();
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

  async function openCameraRoll() {
    elements.cameraRollDialog.showModal();
    elements.cameraRollStatus.textContent = "写真を読み込んでいます...";
    try {
      await Promise.all([loadPhotoMeta(), loadPhotos(true)]);
    } catch (error) {
      elements.cameraRollStatus.textContent = error.message;
    }
  }

  async function loadPhotoMeta() {
    const result = await api("/photos/meta");
    const monthValue = state.photoMonth;
    const authorValue = state.photoAuthor;
    elements.photoMonthFilter.replaceChildren(createOption("", "すべて"), ...(result.months || []).map((item) => (
      createOption(item.value, `${formatMonth(item.value)}（${item.count}）`)
    )));
    elements.photoAuthorFilter.replaceChildren(createOption("", "すべて"), ...(result.authors || []).map((item) => (
      createOption(item.value, `${item.label}（${item.count}）`)
    )));
    elements.photoMonthFilter.value = monthValue;
    elements.photoAuthorFilter.value = authorValue;
  }

  function createOption(value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }

  async function loadPhotos(reset) {
    const requestId = ++state.photoRequestId;
    if (reset) {
      state.photoOffset = 0;
      state.photos = [];
      elements.cameraRollGrid.replaceChildren();
      elements.cameraRollStatus.textContent = "写真を読み込んでいます...";
    }
    const parameters = new URLSearchParams({ limit: "48", offset: String(state.photoOffset) });
    if (state.photoQuery) parameters.set("q", state.photoQuery);
    if (state.photoMonth) parameters.set("month", state.photoMonth);
    if (state.photoAuthor) parameters.set("author", state.photoAuthor);
    const result = await api(`/photos?${parameters}`);
    if (requestId !== state.photoRequestId) return;
    state.photos.push(...result.photos);
    state.photoOffset += result.photos.length;
    state.photoHasMore = Boolean(result.hasMore);
    renderCameraRoll();
  }

  function renderCameraRoll() {
    if (!state.photos.length) {
      elements.cameraRollGrid.replaceChildren(createEmpty("該当する写真はありません。"));
    } else {
      elements.cameraRollGrid.replaceChildren(...state.photos.map((photo, index) => {
        const button = document.createElement("button");
        button.className = "camera-roll-item";
        button.type = "button";
        button.dataset.photoIndex = String(index);
        button.setAttribute("aria-label", `${formatDate(photo.entryDate)}「${photo.entryTitle || "無題"}」の日記を開く`);
        const image = document.createElement("img");
        image.src = photo.thumbnailUrl;
        image.alt = photo.fileName;
        image.loading = "lazy";
        const caption = document.createElement("span");
        caption.className = "camera-roll-caption";
        const date = document.createElement("time");
        date.className = "camera-roll-date";
        date.dateTime = photo.entryDate;
        date.textContent = formatShortDate(photo.entryDate);
        const title = document.createElement("strong");
        title.className = "camera-roll-title";
        title.textContent = photo.entryTitle || "無題";
        caption.append(date, title);
        button.append(image, caption);
        return button;
      }));
    }
    elements.cameraRollStatus.textContent = `${state.photos.length}件の写真を表示しています。`;
    elements.cameraRollMore.hidden = !state.photoHasMore;
  }

  function handleCameraRollClick(event) {
    const button = event.target.closest("[data-photo-index]");
    if (!button) return;
    const photo = state.photos[Number(button.dataset.photoIndex)];
    if (!photo) return;
    elements.cameraRollDialog.close();
    openEntry(photo.entryId);
  }

  function openPhotoViewer(photos, index) {
    if (!photos?.length || index < 0 || index >= photos.length) return;
    state.viewerPhotos = photos;
    state.viewerIndex = index;
    renderPhotoViewer();
    elements.photoViewerDialog.showModal();
  }

  function renderPhotoViewer() {
    const photo = state.viewerPhotos[state.viewerIndex];
    if (!photo) return;
    elements.photoViewerDate.textContent = formatDate(photo.entryDate);
    elements.photoViewerTitle.textContent = photo.entryTitle || "日記の写真";
    elements.photoViewerImage.src = photo.displayUrl;
    elements.photoViewerImage.alt = photo.fileName;
    const dimensions = photo.width && photo.height ? ` / ${photo.width}×${photo.height}` : "";
    elements.photoViewerFile.textContent = `${photo.fileName} / ${formatBytes(photo.originalSize)}${dimensions}`;
    elements.photoDownloadLow.href = `${photo.displayUrl}?download=1`;
    elements.photoDownloadOriginal.href = `${photo.originalUrl}?download=1`;
    elements.photoPrevious.disabled = state.viewerIndex <= 0;
    elements.photoNext.disabled = state.viewerIndex >= state.viewerPhotos.length - 1;
  }

  function movePhotoViewer(direction) {
    const next = state.viewerIndex + direction;
    if (next < 0 || next >= state.viewerPhotos.length) return;
    state.viewerIndex = next;
    renderPhotoViewer();
  }

  function openViewerEntry() {
    const photo = state.viewerPhotos[state.viewerIndex];
    if (!photo) return;
    elements.photoViewerDialog.close();
    if (elements.cameraRollDialog.open) elements.cameraRollDialog.close();
    openEntry(photo.entryId);
  }

  function formatShortDate(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    return year && month && day ? `${year}.${month}.${day}` : "";
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function bindDateInput(input) {
    input.addEventListener("pointerdown", handleDatePointerDown);
    input.addEventListener("pointermove", handleDatePointerMove);
    input.addEventListener("pointerup", handleDatePointerUp);
    input.addEventListener("pointercancel", handleDatePointerCancel);
    input.addEventListener("keydown", handleDateKeydown);
  }

  function handleDatePointerDown(event) {
    if (!useMobileDateWheel()) return;
    event.preventDefault();
    datePointerGestures.set(event.currentTarget, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      moved: false
    });
  }

  function handleDatePointerMove(event) {
    const gesture = datePointerGestures.get(event.currentTarget);
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.moved) return;
    const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (distance > DATE_TAP_MAX_MOVEMENT_PX) gesture.moved = true;
  }

  function handleDatePointerUp(event) {
    const input = event.currentTarget;
    const gesture = datePointerGestures.get(input);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    datePointerGestures.delete(input);
    const duration = performance.now() - gesture.startedAt;
    if (gesture.moved || duration > DATE_TAP_MAX_DURATION_MS) return;
    openDateWheel(input);
  }

  function handleDatePointerCancel(event) {
    datePointerGestures.delete(event.currentTarget);
  }

  function handleDateKeydown(event) {
    if (!useMobileDateWheel() || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openDateWheel(event.currentTarget);
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

  function openDateWheel(target = elements.entryDate) {
    if (elements.dateWheelDialog.open) return;
    state.dateWheelTarget = target;
    setDateDraft(target.value || japanDateString());
    renderDateWheel();
    elements.dateWheelDialog.showModal();
  }

  function closeDateWheel() {
    if (elements.dateWheelDialog.open) elements.dateWheelDialog.close();
    state.dateWheelTarget = null;
  }

  function closeDateWheelFromBackdrop(event) {
    if (event.target === elements.dateWheelDialog) closeDateWheel();
  }

  function applyDateWheel() {
    if (!state.dateDraft) return closeDateWheel();
    const nextValue = datePartsToString(state.dateDraft);
    const target = state.dateWheelTarget || elements.entryDate;
    if (target.value !== nextValue) {
      target.value = nextValue;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
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
      closeEntryDialog();
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
      closeEntryDialog();
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
      closeEntryDialog();
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
    state.month = currentJapanMonth();
    state.monthExpanded = false;
    state.dateFrom = "";
    state.dateTo = "";
    state.tag = "";
    elements.searchInput.value = "";
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    updateFilterControls();
    loadEntries(true);
  }

  function clearFilters() {
    state.query = "";
    state.month = currentJapanMonth();
    state.monthExpanded = false;
    state.dateFrom = "";
    state.dateTo = "";
    state.tag = "";
    state.trash = false;
    elements.searchInput.value = "";
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    updateFilterControls();
    loadEntries(true);
  }

  function resetDateSearch() {
    state.dateFrom = "";
    state.dateTo = "";
    state.monthExpanded = false;
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    updateFilterControls();
    loadEntries(true);
  }

  function updateFilterControls() {
    const active = Boolean(state.query || state.dateFrom || state.dateTo || state.tag || state.trash);
    elements.searchClear.hidden = !state.query;
    elements.dateReset.hidden = !state.dateFrom && !state.dateTo;
    elements.clearFilters.hidden = !active;
    elements.trashButton.textContent = state.trash ? "日記一覧" : "ゴミ箱";
    elements.monthNavigation.hidden = !isMonthlyView();
    document.querySelectorAll("[data-month]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.month === state.month));
    });
    document.querySelectorAll("[data-tag]").forEach((button) => {
      if (button.dataset.tag === state.tag) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function updateListHeading() {
    if (state.trash) {
      elements.listKicker.textContent = "Trash";
      elements.listTitle.textContent = "ゴミ箱";
    } else if (state.tag) {
      elements.listKicker.textContent = "Hashtag";
      elements.listTitle.textContent = `#${state.tag}の記事一覧`;
    } else if (state.query || state.dateFrom || state.dateTo) {
      elements.listKicker.textContent = "Results";
      elements.listTitle.textContent = "検索結果";
    } else {
      elements.listKicker.textContent = "Monthly";
      elements.listTitle.textContent = state.month === currentJapanMonth()
        ? "今月の投稿"
        : formatPostMonth(state.month);
    }
    elements.monthNavigation.hidden = !isMonthlyView();
  }

  function updateSearchStatus() {
    const conditions = [];
    if (state.query) conditions.push(`「${state.query}」`);
    if (isMonthlyView()) conditions.push(formatMonth(state.month));
    if (state.dateFrom || state.dateTo) {
      const from = state.dateFrom || state.dateTo;
      const to = state.dateTo || state.dateFrom;
      conditions.push(from === to ? formatDate(from) : `${formatDate(from)}から${formatDate(to)}`);
    }
    if (state.tag) conditions.push(`#${state.tag}`);
    if (state.trash) {
      elements.searchStatus.textContent = `${state.entries.length}件を表示しています。`;
    } else if (conditions.length) {
      elements.searchStatus.textContent = `${conditions.join("・")}：${state.entries.length}件を表示しています。`;
    } else {
      elements.searchStatus.textContent = `${state.entries.length}件の日記を表示しています。`;
    }
  }

  function handleDateSearchChange() {
    const from = elements.dateFrom.value;
    const to = elements.dateTo.value;
    if (from && to) {
      const fromTime = Date.parse(`${from}T00:00:00Z`);
      const toTime = Date.parse(`${to}T00:00:00Z`);
      if (fromTime > toTime) {
        elements.searchStatus.textContent = "開始日は終了日以前の日付を選択してください。";
        return;
      }
      if ((toTime - fromTime) / 86400000 > 29) {
        elements.searchStatus.textContent = "検索期間が長すぎます。期間を短くしてください。";
        return;
      }
    }
    state.dateFrom = from;
    state.dateTo = to;
    state.monthExpanded = false;
    state.trash = false;
    updateFilterControls();
    loadEntries(true);
  }

  function isMonthlyView() {
    return !state.trash && !state.query && !state.dateFrom && !state.dateTo && !state.tag;
  }

  function changeBrowseMonth(offset) {
    if (!isMonthlyView()) return;
    const nextMonth = shiftMonth(state.month, offset);
    state.month = nextMonth;
    state.monthExpanded = false;
    updateFilterControls();
    loadEntries(true);
  }

  function shiftMonth(value, offset) {
    const [year, month] = String(value || currentJapanMonth()).split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog?.open) return;
    if (id === "entry-dialog") {
      closeEntryDialog();
      return;
    }
    if (id === "editor-dialog" && state.editorDirty && !window.confirm("入力中の内容を破棄しますか？")) return;
    if (id === "editor-dialog") {
      state.editorDirty = false;
      clearEditorPhotos();
    }
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

  function tagSortKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
      .toLocaleLowerCase("ja-JP");
  }

  function createTagElements(tags) {
    return (tags || []).map((tag) => createTagLink(tag, `#${tag}`));
  }

  function createTagLink(tag, label) {
    const link = document.createElement("a");
    link.className = "diary-tag";
    link.dataset.tag = tag;
    link.href = `${BASE_PATH}/tag/${encodeURIComponent(tag)}/`;
    link.textContent = label;
    return link;
  }

  function applyRouteState() {
    const match = window.location.pathname.match(/^\/diary\/tag\/([^/]+)\/?$/);
    let tag = "";
    if (match) {
      try {
        tag = decodeURIComponent(match[1]).normalize("NFKC").trim().slice(0, 100);
      } catch {
        tag = "";
      }
    }
    state.tag = tag;
    const onTagPage = Boolean(tag);
    elements.tagPageBack.hidden = !onTagPage;
    elements.searchPanel.hidden = onTagPage;
    elements.diaryKicker.textContent = onTagPage ? "Hashtag" : "Diary";
    elements.diaryTitle.textContent = onTagPage ? `#${tag}の記事一覧` : "日記";
    document.title = onTagPage ? `#${tag}の記事一覧 | 日記` : "日記";
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

  function formatPostMonth(value) {
    const [year, month] = String(value || "").split("-").map(Number);
    const currentYear = Number(currentJapanMonth().slice(0, 4));
    if (!year || !month) return "月別の投稿";
    return year === currentYear ? `${month}月の投稿` : `${year}年${month}月の投稿`;
  }

  function excerpt(value, length) {
    const text = String(value || "").replace(/\[\[写真:[0-9a-f-]{36}\]\]/gi, "").replace(/\s+/g, " ").trim();
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

  function currentJapanMonth() {
    return japanDateString().slice(0, 7);
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
    state.householdId = null;
    state.activeHouseholdId = null;
    state.isGlobalOwner = false;
    state.mustChangePassword = false;
    state.pendingLoginId = "";
    state.canViewTrash = false;
    state.canPermanentlyDelete = false;
    state.canViewInvestment = false;
    state.entries = [];
    state.entryMap.clear();
    state.offset = 0;
    state.hasMore = false;
    state.query = "";
    state.month = currentJapanMonth();
    state.monthExpanded = false;
    state.dateFrom = "";
    state.dateTo = "";
    state.tag = "";
    state.tagQuery = "";
    state.availableTags = [];
    state.trash = false;
    state.activeEntry = null;
    state.deleteMode = null;
    clearEditorPhotos();
    state.photoOffset = 0;
    state.photos = [];
    state.photoHasMore = false;
    state.photoQuery = "";
    state.photoMonth = "";
    state.photoAuthor = "";
    state.viewerPhotos = [];
    state.viewerIndex = -1;
    state.editorDirty = false;
    state.dateDraft = null;
    state.dateWheelTarget = null;
    state.entryAfterClose = null;
    state.entryHistoryToken = null;
    state.entryClosePending = false;
    elements.searchInput.value = "";
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    elements.tagSearchInput.value = "";
    if (elements.dateWheelDialog.open) elements.dateWheelDialog.close();
    state.requestId += 1;
    if (elements.entryDialog.open) elements.entryDialog.close();
    if (elements.editorDialog.open) elements.editorDialog.close();
    if (elements.cameraRollDialog.open) elements.cameraRollDialog.close();
    if (elements.photoViewerDialog.open) elements.photoViewerDialog.close();
  }
})();

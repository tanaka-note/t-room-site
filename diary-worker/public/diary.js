(() => {
  const BASE_PATH = "/diary";
  const ENTRY_HISTORY_KEY = "troomDiaryEntry";
  const EDITOR_HISTORY_KEY = "troomDiaryEditor";
  const CAMERA_ROLL_HISTORY_KEY = "troomDiaryCameraRoll";
  const PHOTO_VIEWER_HISTORY_KEY = "troomDiaryPhotoViewer";
  const REMEMBER_LOGIN_KEY = "troom-diary-login-remember";
  const RETURN_VIEW_STORAGE_KEY = "troom-diary-return-view-v1";
  const RETURN_VIEW_HISTORY_KEY = "troomDiaryReturnView";
  const RETURN_VIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const PHOTO_UPLOAD_RETRY_DELAYS_MS = Object.freeze([250, 750]);
  const PHOTO_UPLOAD_CONCURRENCY = 2;
  const TAG_SUGGESTION_MAX_HEIGHT = 246;
  const RICH_TEXT_COLORS = Object.freeze({
    default: "#27313b",
    red: "#b42318",
    blue: "#175cd3",
    green: "#067647",
    orange: "#b54708",
    purple: "#6938ef",
    gray: "#667085",
    "light-blue": "#007aa3",
    brown: "#7a4b2a"
  });
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
    canManageEntries: false,
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
    tagDirectory: false,
    favoritePage: false,
    availableTags: [],
    entryTagSuggestionIndex: -1,
    trash: false,
    drafts: false,
    draftCount: 0,
    activeEntry: null,
    editorDirty: false,
    editorSourceEntry: null,
    editorSelection: null,
    editorSelectionOffsets: null,
    editorComposing: false,
    editorToolbarOpen: false,
    dateDraft: null,
    dateWheelTarget: null,
    dateWheelTimers: {},
    searchTimer: null,
    requestId: 0,
    deleteMode: null,
    editorPhotos: [],
    editorDeletedPhotoIds: new Set(),
    photoPreparing: false,
    photoPreparationPromise: null,
    photoUploading: false,
    photoUploadPendingCount: 0,
    photoUploadActiveTasks: new Set(),
    photoUploadSessionId: null,
    photoUploadSessionPromise: null,
    photoUploadTargetEntryId: null,
    photoUploadCommitted: false,
    photoInsertionOffset: null,
    photoOffset: 0,
    photos: [],
    photoHasMore: false,
    photoEntryQuery: "",
    photoMonth: "",
    photoFileNameQuery: "",
    photoRequestId: 0,
    photoSearchTimer: null,
    viewerPhotos: [],
    viewerIndex: -1,
    cameraRollHistoryToken: null,
    cameraRollAfterClose: null,
    cameraRollClosePending: false,
    photoViewerHistoryToken: null,
    photoViewerAfterClose: null,
    photoViewerClosePending: false,
    photoPickerActive: false,
    entryHistoryToken: null,
    entryAfterClose: null,
    entryClosePending: false,
    favoriteRequestPending: false,
    editorHistoryToken: null,
    editorClosePending: false,
    entryCreateRequestId: null,
    deferredInstallPrompt: null,
    lastSessionRefreshAt: 0,
    lastHeaderScrollY: 0,
    headerScrollOffset: 0,
    headerScrollFrame: 0
  };

  const DESKTOP_DIALOG_BACKDROP_MATCHER = "(min-width: 861px) and (hover: hover) and (pointer: fine)";
  const desktopBackdropPointers = new WeakMap();
  let photoPickerReturnHandler = null;
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
    favoritesLink: document.querySelector("#favorites-link"),
    searchPanel: document.querySelector("#diary-search-panel"),
    diaryLayout: document.querySelector("#diary-layout"),
    diaryMain: document.querySelector("#diary-main"),
    roleLabel: document.querySelector("#role-label"),
    householdSwitcherWrap: document.querySelector("#household-switcher-wrap"),
    householdSwitcher: document.querySelector("#household-switcher"),
    cameraRollButton: document.querySelector("#camera-roll-button"),
    newEntryButton: document.querySelector("#new-entry-button"),
    draftButton: document.querySelector("#draft-button"),
    draftCount: document.querySelector("#draft-count"),
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
    currentMonth: document.querySelector("#current-month-button"),
    previousMonth: document.querySelector("#previous-month-button"),
    nextMonth: document.querySelector("#next-month-button"),
    archiveList: document.querySelector("#archive-list"),
    archivePanel: document.querySelector("#archive-panel"),
    tagPanel: document.querySelector("#tag-panel"),
    tagList: document.querySelector("#tag-list"),
    tagSearchInput: document.querySelector("#tag-search-input"),
    tagDirectoryLink: document.querySelector("#tag-directory-link"),
    tagMore: document.querySelector("#tag-more-button"),
    entryDialog: document.querySelector("#entry-dialog"),
    detailDate: document.querySelector("#detail-date"),
    favoriteEntryButton: document.querySelector("#favorite-entry-button"),
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
    entryStatus: document.querySelector("#entry-status"),
    entryDate: document.querySelector("#entry-date"),
    todayButton: document.querySelector("#today-button"),
    entryTitle: document.querySelector("#entry-title"),
    entryContent: document.querySelector("#entry-content"),
    entryContentShell: document.querySelector("#entry-content-shell"),
    entryFormatToggle: document.querySelector("#entry-format-toggle"),
    entryFormatToolbar: document.querySelector("#entry-format-toolbar"),
    addPhotoButton: document.querySelector("#add-photo-button"),
    photoInput: document.querySelector("#photo-input"),
    photoDropZone: document.querySelector("#photo-drop-zone"),
    editorPhotoList: document.querySelector("#editor-photo-list"),
    photoPreparationStatus: document.querySelector("#photo-preparation-status"),
    entryTags: document.querySelector("#entry-tags"),
    entryTagSuggestions: document.querySelector("#entry-tag-suggestions"),
    editorMessage: document.querySelector("#editor-message"),
    cancelEntryButton: document.querySelector("#cancel-entry-button"),
    saveDraftButton: document.querySelector("#save-draft-button"),
    saveEntryButton: document.querySelector("#save-entry-button"),
    editorLeaveDialog: document.querySelector("#editor-leave-dialog"),
    editorLeaveCancel: document.querySelector("#editor-leave-cancel"),
    editorLeaveDiscard: document.querySelector("#editor-leave-discard"),
    editorLeaveSaveDraft: document.querySelector("#editor-leave-save-draft"),
    dateWheelDialog: document.querySelector("#date-wheel-dialog"),
    dateWheelCancel: document.querySelector("#date-wheel-cancel"),
    dateWheelDone: document.querySelector("#date-wheel-done"),
    dateWheelValue: document.querySelector("#date-wheel-value"),
    dateWheelYear: document.querySelector("#date-wheel-year"),
    dateWheelMonth: document.querySelector("#date-wheel-month"),
    dateWheelDay: document.querySelector("#date-wheel-day"),
    cameraRollDialog: document.querySelector("#camera-roll-dialog"),
    photoEntrySearch: document.querySelector("#photo-entry-search"),
    photoMonthFilter: document.querySelector("#photo-month-filter"),
    photoFileNameSearch: document.querySelector("#photo-file-name-search"),
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
    document.addEventListener("troom:before-auto-update", (event) => {
      if (state.editorDirty || state.editorComposing || state.photoPreparing || state.photoUploading || state.photoPickerActive || document.querySelector("dialog[open]")) {
        event.preventDefault();
      }
    });
    window.addEventListener("scroll", scheduleHeaderVisibilityUpdate, { passive: true });
    document.addEventListener("click", rememberDiaryReturnViewFromNavigation, true);
    window.addEventListener("pageshow", restoreDiaryReturnViewFromPageCache);
    elements.loginForm.addEventListener("submit", handleLogin);
    document.querySelector("#passkey-login")?.addEventListener("click", handlePasskeyLogin);
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
    elements.draftButton.addEventListener("click", toggleDrafts);
    elements.trashButton.addEventListener("click", toggleTrash);
    elements.loadMore.addEventListener("click", handleLoadMore);
    elements.currentMonth.addEventListener("click", returnToCurrentMonth);
    elements.previousMonth.addEventListener("click", () => changeBrowseMonth(-1));
    elements.nextMonth.addEventListener("click", () => changeBrowseMonth(1));
    elements.clearFilters.addEventListener("click", clearFilters);
    elements.dateReset.addEventListener("click", resetDateSearch);
    elements.searchClear.addEventListener("click", () => {
      elements.searchInput.value = "";
      state.query = "";
      state.favoritePage = false;
      state.monthExpanded = false;
      updateFilterControls();
      loadEntries(true);
      elements.searchInput.focus();
    });
    elements.searchInput.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.query = elements.searchInput.value.trim();
      state.favoritePage = false;
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
    elements.favoriteEntryButton.addEventListener("click", toggleFavorite);
    elements.deleteEntryButton.addEventListener("click", requestEntryDeletion);
    elements.restoreEntryButton.addEventListener("click", restoreActiveEntry);
    elements.permanentlyDeleteEntryButton.addEventListener("click", requestPermanentDeletion);
    elements.deleteConfirmNo.addEventListener("click", closeDeleteConfirmation);
    elements.deleteConfirmYes.addEventListener("click", confirmEntryDeletion);
    elements.deleteConfirmDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDeleteConfirmation();
    });
    elements.entryForm.addEventListener("submit", postEntry);
    elements.saveDraftButton.addEventListener("click", () => saveEntryAsDraft());
    elements.cancelEntryButton.addEventListener("click", requestEditorClose);
    elements.entryContent.addEventListener("input", handleRichEditorInput);
    elements.entryContent.addEventListener("keydown", handleRichEditorKeydown);
    elements.entryContent.addEventListener("beforeinput", handleRichEditorBeforeInput);
    elements.entryContent.addEventListener("paste", handleRichEditorPaste);
    elements.entryContent.addEventListener("compositionstart", handleRichEditorCompositionStart);
    elements.entryContent.addEventListener("compositionend", handleRichEditorCompositionEnd);
    elements.entryContent.addEventListener("focus", rememberEditorSelection);
    elements.entryContent.addEventListener("pointerdown", handleRichEditorPointerDown);
    elements.entryContent.addEventListener("pointerup", rememberEditorSelection);
    elements.entryContent.addEventListener("keyup", rememberEditorSelection);
    elements.entryFormatToggle.addEventListener("pointerdown", preserveEditorSelectionFromToolbar);
    elements.entryFormatToggle.addEventListener("click", toggleEntryFormatToolbar);
    elements.entryFormatToolbar.addEventListener("pointerdown", preserveEditorSelectionFromToolbar);
    elements.entryFormatToolbar.addEventListener("click", handleEntryFormatAction);
    document.addEventListener("selectionchange", rememberEditorSelection);
    window.addEventListener("resize", positionEntryTagSuggestions, { passive: true });
    elements.editorDialog.addEventListener("scroll", positionEntryTagSuggestions, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleEditorViewportChange);
      window.visualViewport.addEventListener("scroll", handleEditorViewportChange);
    }
    elements.addPhotoButton.addEventListener("click", openPhotoPicker);
    elements.photoInput.addEventListener("change", handlePhotoSelection);
    elements.photoInput.addEventListener("cancel", handlePhotoPickerCancel);
    elements.photoDropZone.addEventListener("click", () => {
      if (!state.photoPreparing) openPhotoPicker();
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
    elements.dateWheelDialog.addEventListener("click", applyDateWheelFromBackdrop);
    bindDateWheel(elements.dateWheelYear, "year");
    bindDateWheel(elements.dateWheelMonth, "month");
    bindDateWheel(elements.dateWheelDay, "day");
    elements.entryForm.addEventListener("input", () => {
      state.editorDirty = true;
    });
    elements.entryTags.addEventListener("input", renderEntryTagSuggestions);
    elements.entryTags.addEventListener("focus", renderEntryTagSuggestions);
    elements.entryTags.addEventListener("click", renderEntryTagSuggestions);
    elements.entryTags.addEventListener("keydown", handleEntryTagSuggestionKeydown);
    elements.entryTagSuggestions.addEventListener("click", handleEntryTagSuggestionClick);
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".entry-tag-input-wrap")) closeEntryTagSuggestions();
    });
    elements.cameraRollMore.addEventListener("click", () => loadPhotos(false));
    elements.cameraRollGrid.addEventListener("click", handleCameraRollClick);
    elements.photoMonthFilter.addEventListener("change", () => {
      state.photoMonth = elements.photoMonthFilter.value;
      loadPhotos(true);
    });
    elements.photoEntrySearch.addEventListener("input", () => {
      window.clearTimeout(state.photoSearchTimer);
      state.photoEntryQuery = elements.photoEntrySearch.value.trim();
      state.photoSearchTimer = window.setTimeout(() => loadPhotos(true), 300);
    });
    elements.photoFileNameSearch.addEventListener("input", () => {
      window.clearTimeout(state.photoSearchTimer);
      state.photoFileNameQuery = elements.photoFileNameSearch.value.trim();
      state.photoSearchTimer = window.setTimeout(() => loadPhotos(true), 300);
    });
    elements.photoPrevious.addEventListener("click", () => movePhotoViewer(-1));
    elements.photoNext.addEventListener("click", () => movePhotoViewer(1));
    elements.photoOpenEntry.addEventListener("click", openViewerEntry);
    elements.photoViewerDialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") movePhotoViewer(-1);
      if (event.key === "ArrowRight") movePhotoViewer(1);
    });
    elements.photoViewerDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePhotoViewerDialog();
    });
    elements.cameraRollDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeCameraRollDialog();
    });

    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
    });
    elements.editorDialog.addEventListener("cancel", (event) => {
      if (event.target !== elements.editorDialog) return;
      event.preventDefault();
      requestEditorClose();
    });
    bindDesktopBackdropClose(elements.entryDialog, closeEntryDialog);
    bindDesktopBackdropClose(elements.editorDialog, requestEditorClose);
    elements.editorLeaveCancel.addEventListener("click", cancelEditorLeave);
    elements.editorLeaveDiscard.addEventListener("click", discardEditorChanges);
    elements.editorLeaveSaveDraft.addEventListener("click", () => saveEntryAsDraft({ closeAfter: true }));
    elements.editorLeaveDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelEditorLeave();
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

  function resetHeaderVisibilityTracking() {
    state.lastHeaderScrollY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    state.headerScrollOffset = 0;
    elements.siteHeader?.style.setProperty("--header-scroll-offset", "0px");
    elements.siteHeader?.classList.remove("is-scroll-hidden");
  }

  function updateHeaderVisibility() {
    state.headerScrollFrame = 0;
    const currentY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    const movement = currentY - state.lastHeaderScrollY;
    const focusedInsideHeader = elements.siteHeader?.contains(document.activeElement);
    const headerHeight = Math.max(0, (elements.siteHeader?.offsetHeight || 0) + 2);

    if (currentY <= 0 || focusedInsideHeader) {
      state.headerScrollOffset = 0;
    } else {
      state.headerScrollOffset = Math.min(
        currentY,
        Math.min(headerHeight, Math.max(0, state.headerScrollOffset + movement))
      );
    }

    elements.siteHeader?.style.setProperty("--header-scroll-offset", `${state.headerScrollOffset}px`);
    elements.siteHeader?.classList.toggle("is-scroll-hidden", state.headerScrollOffset >= headerHeight - 0.5);
    state.lastHeaderScrollY = currentY;
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

  async function handlePasskeyLogin() {
    const button = document.querySelector("#passkey-login");
    setBusy(button, true, "確認中...");
    elements.loginMessage.textContent = "";
    try {
      const authentication = await TRoomPasskeys.authenticate("diary", choosePasskeyLink);
      const session = await api("/passkey/handoff", { method: "POST", body: { handoffToken: authentication.handoff.handoffToken } });
      elements.password.value = "";
      if (session.mustChangePassword) await showInitialPasswordSetup(session);
      else await enterDiary(session);
    } catch (error) {
      elements.loginMessage.textContent = error.message;
    } finally {
      setBusy(button, false, "端末のロック解除でログイン");
    }
  }

  async function choosePasskeyLink(links) {
    return TRoomPasskeys.chooseLinkDialog(links, "diary");
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
    setBusyIconButton(elements.logoutButton, true, "ログアウト処理中", "ログアウト");
    try {
      await api("/logout", { method: "POST" });
    } catch {
      // Cookie is cleared by the server when available. The local view is closed either way.
    }
    resetState();
    showLogin();
    setBusyIconButton(elements.logoutButton, false, "ログアウト処理中", "ログアウト");
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
    state.canManageEntries = Boolean(session.canManageEntries);
    state.canViewTrash = Boolean(session.canViewTrash);
    state.canPermanentlyDelete = Boolean(session.canPermanentlyDelete);
    state.canViewInvestment = Boolean(session.canViewInvestment);
    const returnView = takeDiaryReturnView(state.activeHouseholdId);
    if (returnView) applyDiaryReturnView(returnView);
    state.lastSessionRefreshAt = Date.now();
    elements.roleLabel.textContent = `${session.accountName}（${session.role === "admin" ? "管理者" : "一般ユーザー"}）`;
    elements.newEntryButton.hidden = !state.canManageEntries;
    elements.draftButton.hidden = !state.canManageEntries;
    elements.trashButton.hidden = !state.canViewTrash;
    elements.investmentSection.hidden = !state.canViewInvestment || state.tagDirectory;
    updateFilterControls();
    await Promise.all([loadHouseholdSwitcher(), loadMeta(), loadEntries(true)]);
    if (returnView) {
      await loadEntriesForDiaryReturn(returnView.entryCount);
    }
    elements.bootView.hidden = true;
    elements.loginView.hidden = true;
    elements.appView.hidden = false;
    resetHeaderVisibilityTracking();
    if (returnView) restoreDiaryReturnPosition(returnView);
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
      state.drafts = false;
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
    const previousEntryCount = loadedEntries.length;
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
        if (state.drafts) parameters.set("draft", "1");
        if (state.favoritePage) parameters.set("favorite", "1");

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
      renderEntries(reset ? 0 : previousEntryCount);
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

  function captureEntryListPosition() {
    const visibleEntry = [...elements.entryList.querySelectorAll("[data-entry-id]")]
      .find((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });

    return {
      entryId: visibleEntry?.dataset.entryId || "",
      top: visibleEntry?.getBoundingClientRect().top || 0,
      scrollY: window.scrollY
    };
  }

  function restoreEntryListPosition(position) {
    if (!position) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const anchor = position.entryId
          ? elements.entryList.querySelector(`[data-entry-id="${position.entryId}"]`)
          : null;
        if (anchor) {
          window.scrollBy({
            top: anchor.getBoundingClientRect().top - position.top,
            left: 0,
            behavior: "auto"
          });
          return;
        }
        window.scrollTo({ top: position.scrollY, left: 0, behavior: "auto" });
      });
    });
  }

  function rememberDiaryReturnViewFromNavigation(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!isDiaryListRoute() || elements.appView.hidden) return;
    const link = event.target.closest("a[href]");
    if (!link) return;
    let destination;
    try {
      destination = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    if (destination.origin !== window.location.origin) return;
    if (!destination.pathname.startsWith(`${BASE_PATH}/`)) return;
    if (link === elements.tagPageBack && hasDiaryReturnNavigation(destination.pathname)) {
      event.preventDefault();
      window.history.back();
      return;
    }
    if (destination.pathname === window.location.pathname) return;
    storeDiaryReturnView(destination.pathname);
  }

  function storeDiaryReturnView(destinationPath = "") {
    const position = captureEntryListPosition();
    const returnView = {
      version: 2,
      savedAt: Date.now(),
      routePath: window.location.pathname,
      destinationPath,
      householdId: state.activeHouseholdId || "",
      query: state.query,
      month: state.month,
      monthExpanded: state.monthExpanded,
      dateFrom: state.dateFrom,
      dateTo: state.dateTo,
      tagQuery: state.tagQuery,
      tagQueryInput: elements.tagSearchInput.value,
      trash: state.trash,
      drafts: state.drafts,
      entryCount: state.entries.length,
      position,
      tagListPosition: captureTagListPosition()
    };
    try {
      window.history.replaceState({
        ...(window.history.state || {}),
        [RETURN_VIEW_HISTORY_KEY]: returnView
      }, "", window.location.href);
    } catch {
      // History APIを利用できない場合もsessionStorageのfallbackを維持します。
    }
    try {
      window.sessionStorage.setItem(RETURN_VIEW_STORAGE_KEY, JSON.stringify(returnView));
    } catch {
      // 保存領域が利用できない場合はブラウザ標準の戻る位置復元へ委ねます。
    }
  }

  function takeDiaryReturnView(householdId) {
    const historyView = window.history.state?.[RETURN_VIEW_HISTORY_KEY];
    if (isUsableDiaryReturnView(historyView, householdId, window.location.pathname)) {
      return historyView;
    }
    let returnView = null;
    try {
      returnView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
    } catch {
      return null;
    }
    const expectedRoute = returnView?.version === 1 ? `${BASE_PATH}/` : returnView?.routePath;
    if (!isUsableDiaryReturnView(returnView, householdId, expectedRoute)) return null;
    if (returnView.version === 2 && !isDiaryReturnReferrer(returnView.destinationPath)) return null;
    try {
      window.sessionStorage.removeItem(RETURN_VIEW_STORAGE_KEY);
    } catch {
      // 読み取り済み状態を消せなくても、期限とrouteで誤適用を防ぎます。
    }
    return returnView;
  }

  function isUsableDiaryReturnView(returnView, householdId, expectedRoute) {
    if (!returnView || ![1, 2].includes(returnView.version)) return false;
    if (!Number.isFinite(returnView.savedAt) || Date.now() - returnView.savedAt > RETURN_VIEW_MAX_AGE_MS) return false;
    if (returnView.householdId && householdId && returnView.householdId !== householdId) return false;
    const routePath = returnView.version === 1 ? `${BASE_PATH}/` : returnView.routePath;
    return routePath === expectedRoute && expectedRoute === window.location.pathname;
  }

  function isDiaryReturnReferrer(destinationPath) {
    try {
      const referrer = new URL(document.referrer);
      return referrer.origin === window.location.origin && referrer.pathname === destinationPath;
    } catch {
      return false;
    }
  }

  function applyDiaryReturnView(returnView) {
    state.query = String(returnView.query || "").slice(0, 200);
    state.month = /^\d{4}-\d{2}$/.test(returnView.month) ? returnView.month : currentJapanMonth();
    state.monthExpanded = Boolean(returnView.monthExpanded);
    state.dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(returnView.dateFrom) ? returnView.dateFrom : "";
    state.dateTo = /^\d{4}-\d{2}-\d{2}$/.test(returnView.dateTo) ? returnView.dateTo : "";
    state.tagQuery = String(returnView.tagQuery || "").normalize("NFKC").trim().toLocaleLowerCase("ja-JP").slice(0, 100);
    state.trash = Boolean(returnView.trash && state.canViewTrash);
    state.drafts = Boolean(returnView.drafts && state.canManageEntries);
    if (state.drafts) state.trash = false;
    elements.searchInput.value = state.query;
    elements.dateFrom.value = state.dateFrom;
    elements.dateTo.value = state.dateTo;
    elements.tagSearchInput.value = String(returnView.tagQueryInput || returnView.tagQuery || "").slice(0, 100);
  }

  async function loadEntriesForDiaryReturn(entryCount) {
    const targetCount = Math.max(0, Math.min(Number(entryCount) || 0, 2000));
    let pageGuard = 0;
    while (state.entries.length < targetCount && state.hasMore && pageGuard < 100) {
      await loadEntries(false);
      pageGuard += 1;
    }
  }

  function captureTagListPosition() {
    const containerRect = elements.tagList.getBoundingClientRect();
    const visibleTag = [...elements.tagList.querySelectorAll("[data-tag]")]
      .find((tag) => {
        const rect = tag.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
    return {
      tag: visibleTag?.dataset.tag || "",
      top: visibleTag ? visibleTag.getBoundingClientRect().top - containerRect.top : 0,
      scrollTop: elements.tagList.scrollTop,
      scrollLeft: elements.tagList.scrollLeft
    };
  }

  function restoreTagListPosition(position) {
    if (!position) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        elements.tagList.scrollTo({
          top: Math.max(0, Number(position.scrollTop) || 0),
          left: Math.max(0, Number(position.scrollLeft) || 0),
          behavior: "auto"
        });
        const anchor = position.tag
          ? [...elements.tagList.querySelectorAll("[data-tag]")].find((tag) => tag.dataset.tag === position.tag)
          : null;
        if (!anchor) return;
        elements.tagList.scrollBy({
          top: anchor.getBoundingClientRect().top - elements.tagList.getBoundingClientRect().top - (Number(position.top) || 0),
          left: 0,
          behavior: "auto"
        });
      });
    });
  }

  function restoreDiaryReturnPosition(returnView) {
    if (!returnView) return;
    const restore = () => {
      restoreEntryListPosition(returnView.position);
      restoreTagListPosition(returnView.tagListPosition);
    };
    restore();
    window.setTimeout(restore, 120);
    window.setTimeout(restore, 400);
  }

  function restoreDiaryReturnViewFromPageCache(event) {
    if (!event.persisted || !isDiaryListRoute()) return;
    const returnView = takeDiaryReturnView(state.activeHouseholdId);
    if (returnView) restoreDiaryReturnPosition(returnView);
  }

  function isDiaryHomeRoute() {
    return /^\/diary\/?$/.test(window.location.pathname);
  }

  function isDiaryListRoute() {
    return isDiaryListPath(window.location.pathname);
  }

  function hasDiaryReturnNavigation(destinationPath) {
    let returnView = null;
    try {
      returnView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
    } catch {
      return false;
    }
    return returnView?.version === 2
      && returnView.destinationPath === window.location.pathname
      && returnView.routePath === destinationPath
      && Date.now() - returnView.savedAt <= RETURN_VIEW_MAX_AGE_MS;
  }

  async function handleLoadMore() {
    if (isMonthlyView()) {
      const position = captureEntryListPosition();
      elements.loadMore.blur();
      state.monthExpanded = true;
      await loadEntries(false);
      restoreEntryListPosition(position);
      return;
    }
    await loadEntries(false);
  }

  async function loadMeta() {
    try {
      const result = await api("/meta");
      state.draftCount = Number(result.draftCount || 0);
      elements.draftCount.textContent = String(state.draftCount);
      elements.draftCount.hidden = state.draftCount < 1;
      elements.draftCount.setAttribute("aria-label", `下書き${state.draftCount}件`);
      updateFilterControls();
      renderArchive(result.months || []);
      renderTags(result.tags || []);
    } catch (error) {
      elements.archiveList.replaceChildren(createEmpty(error.message));
      elements.tagList.replaceChildren(createEmpty(error.message));
    }
  }

  function renderEntries(appendFrom = 0) {
    if (!state.entries.length) {
      const message = state.drafts
        ? "下書きはありません。"
        : state.trash
        ? "ゴミ箱は空です。"
        : state.favoritePage
          ? "お気に入りの日記はまだありません。"
        : isMonthlyView()
          ? "記事なし"
          : state.query || state.dateFrom || state.dateTo || state.tag
          ? "条件に合う日記はありません。"
          : "まだ日記はありません。";
      elements.entryList.replaceChildren(createEmpty(message));
      return;
    }

    const existingCardCount = elements.entryList.querySelectorAll(":scope > .diary-entry-card").length;
    const canAppend = appendFrom > 0 && existingCardCount === appendFrom;
    const entriesToRender = canAppend ? state.entries.slice(appendFrom) : state.entries;
    const cards = entriesToRender.map((entry) => {
      const article = document.createElement("article");
      article.className = "diary-entry-card";
      article.classList.toggle("is-draft", state.drafts);

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
      meta.append(time);
      if (shouldShowEntryAuthor()) meta.append(author);
      if (state.trash && entry.deletedByName) {
        const deletedBy = document.createElement("span");
        deletedBy.className = "entry-author";
        deletedBy.textContent = `削除者：${entry.deletedByName}`;
        meta.append(deletedBy);
      }
      const title = document.createElement("h3");
      title.textContent = entry.title || "無題の下書き";
      const summary = document.createElement("p");
      summary.textContent = excerpt(entry.content, 130) || (state.drafts ? "本文はまだありません。" : "");
      button.append(meta, title, summary);
      if (state.drafts) {
        const updated = document.createElement("span");
        updated.className = "draft-updated-at";
        updated.textContent = `最終編集：${formatDateTime(entry.updatedAt)}`;
        button.append(updated);
      }
      article.append(button, createTagGroup(entry.tags));
      return article;
    });
    if (canAppend) {
      elements.entryList.append(...cards);
      return;
    }
    elements.entryList.replaceChildren(...cards);
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
      elements.tagMore.hidden = true;
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
    elements.tagMore.hidden = state.tagDirectory;
  }

  function renderEntryTagSuggestions() {
    const context = currentEntryTagContext();
    const query = normalizeTagForMatch(context.value);
    const selected = new Set(context.otherTags.map(normalizeTagForMatch));
    const suggestions = state.availableTags
      .filter((item) => !selected.has(normalizeTagForMatch(item.value)))
      .filter((item) => !query || normalizeTagForMatch(item.value).startsWith(query))
      .sort((left, right) => {
        return Number(right.count || 0) - Number(left.count || 0)
          || tagCollator.compare(tagSortKey(left.value), tagSortKey(right.value));
      });
    if (!suggestions.length || !elements.editorDialog.open) return closeEntryTagSuggestions();
    state.entryTagSuggestionIndex = -1;
    elements.entryTagSuggestions.replaceChildren(...suggestions.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-tag-suggestion";
      button.id = `entry-tag-suggestion-${index}`;
      button.dataset.tag = item.value;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      const name = document.createElement("span");
      name.textContent = `#${item.value}`;
      const count = document.createElement("small");
      count.textContent = `${item.count || 0}件`;
      button.append(name, count);
      return button;
    }));
    elements.entryTagSuggestions.hidden = false;
    elements.entryTags.setAttribute("aria-expanded", "true");
    positionEntryTagSuggestions();
  }

  function positionEntryTagSuggestions() {
    const suggestionList = elements.entryTagSuggestions;
    if (suggestionList.hidden || !elements.editorDialog.open) return;
    const inputRect = elements.entryTags.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const edge = 8;
    const gap = 4;
    const availableBelow = Math.max(0, viewportBottom - inputRect.bottom - gap - edge);
    const availableAbove = Math.max(0, inputRect.top - viewportTop - gap - edge);
    const placeAbove = availableBelow < Math.min(160, TAG_SUGGESTION_MAX_HEIGHT) && availableAbove > availableBelow;
    const availableHeight = placeAbove ? availableAbove : availableBelow;
    const maxHeight = Math.min(TAG_SUGGESTION_MAX_HEIGHT, availableHeight);
    const width = Math.min(inputRect.width, Math.max(0, viewportWidth - (edge * 2)));
    const left = Math.min(
      Math.max(inputRect.left, viewportLeft + edge),
      Math.max(viewportLeft + edge, viewportRight - edge - width)
    );

    suggestionList.style.left = `${Math.round(left)}px`;
    suggestionList.style.width = `${Math.round(width)}px`;
    suggestionList.style.maxHeight = `${Math.floor(maxHeight)}px`;
    suggestionList.dataset.placement = placeAbove ? "above" : "below";

    const renderedHeight = Math.min(suggestionList.getBoundingClientRect().height, maxHeight);
    const top = placeAbove
      ? Math.max(viewportTop + edge, inputRect.top - gap - renderedHeight)
      : inputRect.bottom + gap;
    suggestionList.style.top = `${Math.round(top)}px`;
  }

  function currentEntryTagContext() {
    const value = elements.entryTags.value;
    const caret = Number.isInteger(elements.entryTags.selectionStart) ? elements.entryTags.selectionStart : value.length;
    const beforeCaret = value.slice(0, caret);
    const delimiterIndex = Math.max(beforeCaret.lastIndexOf("、"), beforeCaret.lastIndexOf(","), beforeCaret.lastIndexOf("，"));
    const start = delimiterIndex + 1;
    const remainder = value.slice(caret);
    const nextDelimiter = remainder.search(/[、,，]/);
    const end = nextDelimiter < 0 ? value.length : caret + nextDelimiter;
    const otherTags = parseTags(`${value.slice(0, start)}${value.slice(end)}`);
    return { start, end, value: value.slice(start, end).trim().replace(/^#+/, ""), otherTags };
  }

  function normalizeTagForMatch(value) {
    return String(value || "").normalize("NFKC").trim().replace(/^#+/, "").toLocaleLowerCase("ja-JP");
  }

  function handleEntryTagSuggestionClick(event) {
    const button = event.target.closest("[data-tag]");
    if (button) applyEntryTagSuggestion(button.dataset.tag);
  }

  function handleEntryTagSuggestionKeydown(event) {
    if (elements.entryTagSuggestions.hidden || !["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeEntryTagSuggestions();
      return;
    }
    const options = [...elements.entryTagSuggestions.querySelectorAll("[data-tag]")];
    if (!options.length) return;
    event.preventDefault();
    if (event.key === "Enter") {
      const selected = options[state.entryTagSuggestionIndex];
      if (selected) applyEntryTagSuggestion(selected.dataset.tag);
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.entryTagSuggestionIndex = (state.entryTagSuggestionIndex + direction + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute("aria-selected", String(index === state.entryTagSuggestionIndex)));
    const activeOption = options[state.entryTagSuggestionIndex];
    elements.entryTags.setAttribute("aria-activedescendant", activeOption.id);
    activeOption.scrollIntoView({ block: "nearest" });
  }

  function applyEntryTagSuggestion(tag) {
    const context = currentEntryTagContext();
    elements.entryTags.setRangeText(tag, context.start, context.end, "end");
    elements.entryTags.dispatchEvent(new Event("input", { bubbles: true }));
    closeEntryTagSuggestions();
    elements.entryTags.focus();
  }

  function closeEntryTagSuggestions() {
    state.entryTagSuggestionIndex = -1;
    elements.entryTagSuggestions.hidden = true;
    elements.entryTagSuggestions.replaceChildren();
    elements.entryTagSuggestions.removeAttribute("data-placement");
    for (const property of ["left", "top", "width", "max-height"]) {
      elements.entryTagSuggestions.style.removeProperty(property);
    }
    elements.entryTags.setAttribute("aria-expanded", "false");
    elements.entryTags.removeAttribute("aria-activedescendant");
  }

  function handleEntryListClick(event) {
    const button = event.target.closest("[data-entry-id]");
    if (!button) return;
    if (state.drafts) openDraft(Number(button.dataset.entryId));
    else openEntry(Number(button.dataset.entryId));
  }

  async function openDraft(id) {
    try {
      const result = await api(`/entries/${id}`);
      if (result.entry.status !== "draft") throw new Error("下書きが見つかりません。");
      openEditor(result.entry);
    } catch (error) {
      showToast(error.message);
    }
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
    state.drafts = false;
    state.favoritePage = false;
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

  function pushEditorHistory() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.editorHistoryToken = token;
    state.editorClosePending = false;
    window.history.pushState({
      ...(window.history.state || {}),
      [EDITOR_HISTORY_KEY]: token
    }, "", window.location.href);
  }

  function pushCameraRollHistory() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.cameraRollHistoryToken = token;
    state.cameraRollClosePending = false;
    window.history.pushState({
      ...(window.history.state || {}),
      [CAMERA_ROLL_HISTORY_KEY]: token
    }, "", window.location.href);
  }

  function pushPhotoViewerHistory() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.photoViewerHistoryToken = token;
    state.photoViewerClosePending = false;
    window.history.pushState({
      ...(window.history.state || {}),
      [PHOTO_VIEWER_HISTORY_KEY]: token
    }, "", window.location.href);
  }

  function requestEditorClose() {
    if (!elements.editorDialog.open) return;
    if (state.editorDirty) {
      if (!elements.editorLeaveDialog.open) elements.editorLeaveDialog.showModal();
      return;
    }
    closeEditorDialog();
  }

  function cancelEditorLeave() {
    if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
    window.setTimeout(() => elements.entryContent.focus(), 0);
  }

  async function discardEditorChanges() {
    if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
    await cancelEditorPhotoUploadSession();
    state.editorDirty = false;
    closeEditorDialog();
  }

  function closeEditorDialog() {
    if (state.editorClosePending) return;
    if (!elements.editorDialog.open) {
      finishEditorClose();
      return;
    }
    if (
      state.editorHistoryToken
      && window.history.state?.[EDITOR_HISTORY_KEY] === state.editorHistoryToken
    ) {
      state.editorClosePending = true;
      window.history.back();
      return;
    }
    finishEditorClose();
  }

  function finishEditorClose() {
    state.editorHistoryToken = null;
    state.editorClosePending = false;
    state.editorDirty = false;
    state.editorSourceEntry = null;
    if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
    if (elements.editorDialog.open) elements.editorDialog.close();
    clearEditorPhotos();
    closeEntryFormatToolbar();
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

  function isDesktopDialogBackdropEnabled() {
    return window.matchMedia(DESKTOP_DIALOG_BACKDROP_MATCHER).matches;
  }

  function bindDesktopBackdropClose(dialog, onClose) {
    dialog.addEventListener("pointerdown", (event) => {
      if (!isDesktopDialogBackdropPointer(event, dialog)) return;
      desktopBackdropPointers.set(dialog, event.pointerId);
    });
    dialog.addEventListener("pointerup", (event) => {
      const pointerId = desktopBackdropPointers.get(dialog);
      desktopBackdropPointers.delete(dialog);
      if (pointerId !== event.pointerId) return;
      if (!isDesktopDialogBackdropPointer(event, dialog)) return;
      onClose();
    });
    dialog.addEventListener("pointercancel", () => desktopBackdropPointers.delete(dialog));
  }

  function isDesktopDialogBackdropPointer(event, dialog) {
    if (state.photoPickerActive) return false;
    if (!isDesktopDialogBackdropEnabled()) return false;
    if (event.target !== dialog) return false;
    const content = dialog.firstElementChild;
    if (!content) return true;
    const rect = content.getBoundingClientRect();
    return event.clientX < rect.left
      || event.clientX > rect.right
      || event.clientY < rect.top
      || event.clientY > rect.bottom;
  }

  function handleHistoryNavigation() {
    if (elements.photoViewerDialog.open && state.photoViewerHistoryToken) {
      finishPhotoViewerClose();
      return;
    }
    if (elements.cameraRollDialog.open && state.cameraRollHistoryToken) {
      finishCameraRollClose();
      return;
    }
    if (elements.editorDialog.open && state.editorHistoryToken) {
      if (state.editorClosePending || !state.editorDirty) {
        finishEditorClose();
      } else {
        pushEditorHistory();
        if (!elements.editorLeaveDialog.open) elements.editorLeaveDialog.showModal();
      }
      return;
    }
    if (state.entryHistoryToken && elements.entryDialog.open) finishEntryClose();
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
    elements.detailAuthor.hidden = !shouldShowEntryAuthor();
    elements.detailDeletion.hidden = !entry.deletedAt || !entry.deletedByName;
    elements.detailDeletion.textContent = entry.deletedByName ? `削除者：${entry.deletedByName}` : "";
    renderFavoriteButton(entry);
    renderEntryContent(entry);
    elements.detailTags.replaceChildren(...createTagElements(entry.tags));
    const isDeleted = Boolean(entry.deletedAt);
    elements.detailActions.hidden = !state.canManageEntries || isDeleted;
    elements.restoreActions.hidden = !state.canViewTrash || !isDeleted;
    elements.deleteEntryButton.textContent = state.canViewTrash ? "ゴミ箱へ移動" : "削除";
    elements.permanentlyDeleteEntryButton.hidden = !state.canPermanentlyDelete || !isDeleted;
  }

  function renderFavoriteButton(entry) {
    const canFavorite = entry.status === "published" && !entry.deletedAt;
    elements.favoriteEntryButton.hidden = !canFavorite;
    if (!canFavorite) return;
    const isFavorite = entry.isFavorite === true;
    elements.favoriteEntryButton.setAttribute("aria-pressed", String(isFavorite));
    const label = isFavorite ? "お気に入りから解除" : "お気に入りに追加";
    elements.favoriteEntryButton.setAttribute("aria-label", label);
    elements.favoriteEntryButton.title = label;
    elements.favoriteEntryButton.removeAttribute("aria-busy");
  }

  async function toggleFavorite() {
    const entry = state.activeEntry;
    if (!entry || entry.status !== "published" || entry.deletedAt || state.favoriteRequestPending) return;
    state.favoriteRequestPending = true;
    const shouldFavorite = entry.isFavorite !== true;
    elements.favoriteEntryButton.disabled = true;
    elements.favoriteEntryButton.setAttribute("aria-busy", "true");
    try {
      const result = await api(`/entries/${entry.id}/favorite`, {
        method: shouldFavorite ? "POST" : "DELETE"
      });
      entry.isFavorite = result.isFavorite === true;
      const listedEntry = state.entryMap.get(entry.id);
      if (listedEntry) listedEntry.isFavorite = entry.isFavorite;
      if (state.favoritePage && !entry.isFavorite) {
        state.entries = state.entries.filter((item) => item.id !== entry.id);
        state.entryMap.delete(entry.id);
        state.offset = state.entries.length;
        renderEntries();
        updateSearchStatus();
      }
      renderFavoriteButton(entry);
    } catch (error) {
      showToast(error.message);
      renderFavoriteButton(entry);
    } finally {
      state.favoriteRequestPending = false;
      elements.favoriteEntryButton.disabled = false;
      elements.favoriteEntryButton.removeAttribute("aria-busy");
    }
  }

  function renderEntryContent(entry) {
    const photos = new Map((entry.photos || []).map((photo) => [photo.id, photo]));
    const rendered = new Set();
    const fragment = document.createDocumentFragment();
    const markerPattern = /\[\[写真:([0-9a-f-]{36})\]\]/gi;
    let cursor = 0;
    let match;
    while ((match = markerPattern.exec(entry.content)) !== null) {
      appendEntryText(fragment, entry.content.slice(cursor, match.index), entry.contentFormat, cursor);
      const photo = photos.get(match[1].toLowerCase());
      if (photo) {
        fragment.append(createEntryPhoto(photo, entry.photos));
        rendered.add(photo.id);
      }
      cursor = match.index + match[0].length;
    }
    appendEntryText(fragment, entry.content.slice(cursor), entry.contentFormat, cursor);
    for (const photo of entry.photos || []) {
      if (!rendered.has(photo.id)) fragment.append(createEntryPhoto(photo, entry.photos));
    }
    elements.detailContent.replaceChildren(fragment);
  }

  const ENTRY_TEXT_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`[\]{}()<>]+/g;
  const ENTRY_TEXT_LINK_TRIM_TRAILING = /[.,。、!?！？)\]\}"'”』】〉》）]+$/u;
  const ENTRY_TEXT_LINK_TEXT_BODY = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

  function findEntryTextLinks(text) {
      const source = String(text || "");
      const links = [];
      ENTRY_TEXT_LINK_PATTERN.lastIndex = 0;
      let match;
      while ((match = ENTRY_TEXT_LINK_PATTERN.exec(source)) !== null) {
        const matched = match[0];
        let end = matched.length;
        while (end > 0 && ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[end - 1])) end -= 1;
        if (end === matched.length) {
          for (let i = end - 1; i > 0; i -= 1) {
            if (!ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[i])) {
              continue;
            }
            if (ENTRY_TEXT_LINK_TEXT_BODY.test(matched[i + 1])) {
              break;
            }
            end = i + 1;
            while (end > 0 && ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[end - 1])) end -= 1;
            break;
          }
        }
        if (end === 0) continue;
        const textValue = matched.slice(0, end);
      const href = textValue.startsWith("www.")
        ? `https://${textValue}`
        : textValue;
      if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
      try {
        const parsed = new URL(href);
        if (!["http:", "https:"].includes(parsed.protocol)) continue;
      } catch (error) {
        continue;
      }
      const valueStart = match.index;
      links.push({
        start: valueStart,
        end: valueStart + textValue.length,
        text: textValue,
        href
      });
    }
    return links;
  }

  function normalizeEntryTextRuns(textLength, runs) {
    return (Array.isArray(runs) ? runs : []).map((run) => {
      const start = Math.max(0, Math.min(Number(run.start) || 0, textLength));
      const end = Math.max(start, Math.min(Number(run.end) || 0, textLength));
      return { ...run, start, end };
    }).filter((run) => run.end > run.start).sort((left, right) => left.start - right.start);
  }

  function resolveEntryTextMarks(runs, start, end) {
    const marks = {
      bold: false,
      italic: false,
      underline: false,
      color: null
    };
    for (const run of runs) {
      if (run.end <= start || run.start >= end) continue;
      if (run.bold) marks.bold = true;
      if (run.italic) marks.italic = true;
      if (run.underline) marks.underline = true;
      if (run.color) marks.color = run.color;
    }
    return hasTextMarks(marks) ? marks : null;
  }

  function tokenizeEntryTextWithLinks(text, runs = []) {
    const source = String(text || "");
    if (!source) return [];
    const linkTokens = findEntryTextLinks(source);
    const normalizedRuns = normalizeEntryTextRuns(source.length, runs);
    const boundaries = new Set([0, source.length]);
    for (const run of normalizedRuns) {
      boundaries.add(run.start);
      boundaries.add(run.end);
    }
    for (const link of linkTokens) {
      boundaries.add(link.start);
      boundaries.add(link.end);
    }
    const points = [...boundaries].sort((left, right) => left - right);
    const tokens = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (start === end) continue;
      const link = linkTokens.find((candidate) => candidate.start <= start && candidate.end >= end);
      tokens.push({
        kind: link ? "link" : "text",
        text: source.slice(start, end),
        start,
        end,
        marks: resolveEntryTextMarks(normalizedRuns, start, end),
        href: link?.href,
        linkText: link?.text
      });
    }
    return tokens;
  }

  function appendEntryText(fragment, text, contentFormat = null, baseOffset = 0) {
    if (!text) return;
    const relevantRuns = Array.isArray(contentFormat?.runs) ? contentFormat.runs.flatMap((run) => {
      const start = Math.max(0, Math.min(text.length, Number(run.start) - baseOffset));
      const end = Math.max(start, Math.min(text.length, Number(run.end) - baseOffset));
      return end > start ? [{ ...run, start, end }] : [];
    }) : [];
    const tokens = tokenizeEntryTextWithLinks(text, relevantRuns);
    let activeLink = null;
    for (const token of tokens) {
      if (token.kind === "link" && token.href && token.linkText) {
        if (!activeLink || activeLink.href !== token.href) {
          if (activeLink) fragment.append(activeLink.element);
          activeLink = createEntryTextLink(token.href);
        }
        activeLink.element.append(createEntryTextSpan(token.text, token.marks));
        continue;
      }
      if (activeLink) {
        fragment.append(activeLink.element);
        activeLink = null;
      }
      fragment.append(createEntryTextSpan(token.text, token.marks));
    }
    if (activeLink) {
      fragment.append(activeLink.element);
    }
  }

  function createEntryTextLink(href) {
    const link = document.createElement("a");
    link.className = "entry-content-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return { href, element: link };
  }

  function createEntryTextSpan(text, marks = null) {
    const span = marks ? createFormattedTextSpan(text, marks) : document.createElement("span");
    span.classList.add("entry-content-text");
    if (!marks) span.textContent = text;
    return span;
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
    finishPhotoPickerInteraction();
    const files = [...(elements.photoInput.files || [])];
    elements.photoInput.value = "";
    const insertionOffset = state.photoInsertionOffset ?? getEditorSelectionOffset("end");
    state.photoInsertionOffset = null;
    await prepareSelectedPhotos(files, insertionOffset);
  }

  function handlePhotoPickerCancel(event) {
    event.stopPropagation();
    finishPhotoPickerInteraction();
  }

  function openPhotoPicker() {
    state.photoInsertionOffset = getEditorSelectionOffset("end");
    finishPhotoPickerInteraction();
    state.photoPickerActive = true;
    photoPickerReturnHandler = () => {
      window.requestAnimationFrame(finishPhotoPickerInteraction);
    };
    window.addEventListener("focus", photoPickerReturnHandler, { once: true });
    try {
      elements.photoInput.click();
    } catch (error) {
      finishPhotoPickerInteraction();
      throw error;
    }
  }

  function finishPhotoPickerInteraction() {
    state.photoPickerActive = false;
    if (photoPickerReturnHandler) {
      window.removeEventListener("focus", photoPickerReturnHandler);
      photoPickerReturnHandler = null;
    }
  }

  function handlePhotoDropKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!state.photoPreparing) openPhotoPicker();
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
    prepareSelectedPhotos([...(event.dataTransfer?.files || [])], getEditorSelectionOffset("end"));
  }

  function prepareSelectedPhotos(files, insertionOffset = getEditorSelectionOffset("end")) {
    if (!files.length) return Promise.resolve();
    if (state.photoPreparationPromise) return state.photoPreparationPromise;
    const preparation = runPhotoPreparation(files, insertionOffset);
    const trackedPreparation = preparation.finally(() => {
      if (state.photoPreparationPromise === trackedPreparation) state.photoPreparationPromise = null;
    });
    state.photoPreparationPromise = trackedPreparation;
    return trackedPreparation;
  }

  async function runPhotoPreparation(files, insertionOffset) {
    state.photoPreparing = true;
    elements.photoInput.disabled = true;
    elements.photoDropZone.classList.add("is-busy");
    elements.photoDropZone.setAttribute("aria-disabled", "true");
    setBusy(elements.addPhotoButton, true, "準備中...");
    elements.photoPreparationStatus.textContent = `${files.length}件の写真を準備しています。`;
    const failures = [];
    const preparedPhotos = [];
    let preparedCount = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        elements.photoPreparationStatus.textContent = `写真を準備中 ${index + 1}/${files.length}`;
        try {
          const photo = await preparePhoto(file);
          state.editorPhotos.push(photo);
          preparedPhotos.push(photo);
          preparedCount += 1;
          queueBackgroundPhotoUpload(photo);
        } catch (error) {
          failures.push(`${file.name}：${error.message}`);
        }
      }
      await waitForEditorCompositionEnd();
      if (preparedPhotos.length) {
        insertPhotoMarkersAtOffset(preparedPhotos.map((photo) => photo.id), insertionOffset);
      }
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

  async function waitForPhotoPreparation() {
    const preparation = state.photoPreparationPromise;
    if (preparation) await preparation;
  }

  async function preparePhoto(file) {
    if (!(file instanceof File) || !String(file.type).startsWith("image/")) {
      throw new Error("画像ファイルではありません。");
    }
    if (!file.size || file.size > 60 * 1024 * 1024) throw new Error("60MB以内の画像を選択してください。");
    const imageSource = await preparePhotoSource(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(imageSource.source, { imageOrientation: "none" });
    } catch {
      try {
        // Some older implementations reject the options dictionary. The JPEG
        // copy has already had its EXIF orientation neutralized, so this
        // fallback is still independent of the browser's EXIF handling.
        bitmap = await createImageBitmap(imageSource.source);
      } catch {
        throw new Error("この画像形式をブラウザで読み取れませんでした。");
      }
    }
    try {
      const [displayBlob, thumbnailBlob] = await Promise.all([
        resizePhoto(bitmap, 1800, 320 * 1024, 0.88, imageSource.orientation),
        resizePhoto(bitmap, 480, 100 * 1024, 0.82, imageSource.orientation)
      ]);
      const orientedSize = orientedImageSize(bitmap.width, bitmap.height, imageSource.orientation);
      const id = crypto.randomUUID().toLowerCase();
      return {
        id,
        fileName: file.name || "photo",
        originalFile: file,
        displayBlob,
        thumbnailBlob,
        width: orientedSize.width,
        height: orientedSize.height,
        previewUrl: URL.createObjectURL(thumbnailBlob),
        existing: false,
        uploadState: "preparing",
        uploadPromise: null,
        uploadError: null,
        removed: false
      };
    } finally {
      bitmap.close();
    }
  }

  async function preparePhotoSource(file) {
    const isJpeg = /^image\/(?:jpeg|jpg)$/i.test(String(file.type || "")) || /\.jpe?g$/i.test(String(file.name || ""));
    if (!isJpeg) return { source: file, orientation: 1 };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const exif = readJpegOrientation(bytes);
    if (!exif) return { source: file, orientation: 1 };
    const normalizedBytes = bytes.slice();
    writeExifOrientation(normalizedBytes, exif.valueOffset, exif.littleEndian, 1);
    return {
      source: new Blob([normalizedBytes], { type: file.type || "image/jpeg" }),
      orientation: exif.orientation
    };
  }

  function readJpegOrientation(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      const segmentLength = readBigEndianUint16(bytes, offset);
      if (!segmentLength || offset + segmentLength > bytes.length) break;
      if (marker === 0xe1 && segmentLength >= 8 &&
          bytes[offset + 2] === 0x45 && bytes[offset + 3] === 0x78 &&
          bytes[offset + 4] === 0x69 && bytes[offset + 5] === 0x66 &&
          bytes[offset + 6] === 0x00 && bytes[offset + 7] === 0x00) {
        const tiffOffset = offset + 8;
        const littleEndian = bytes[tiffOffset] === 0x49 && bytes[tiffOffset + 1] === 0x49;
        const bigEndian = bytes[tiffOffset] === 0x4d && bytes[tiffOffset + 1] === 0x4d;
        if (!littleEndian && !bigEndian) return null;
        const read16 = (position) => readEndianUint16(bytes, position, littleEndian);
        const read32 = (position) => readEndianUint32(bytes, position, littleEndian);
        if (read16(tiffOffset + 2) !== 42) return null;
        const ifdOffset = read32(tiffOffset + 4);
        const ifd = tiffOffset + ifdOffset;
        if (ifd < tiffOffset || ifd + 2 > offset + segmentLength) return null;
        const entryCount = read16(ifd);
        for (let index = 0; index < entryCount; index += 1) {
          const entry = ifd + 2 + index * 12;
          if (entry + 12 > offset + segmentLength) break;
          if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3 || read32(entry + 4) < 1) continue;
          const valueOffset = entry + 8;
          const orientation = read16(valueOffset);
          return {
            orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
            valueOffset,
            littleEndian
          };
        }
        return null;
      }
      offset += segmentLength;
    }
    return null;
  }

  function readBigEndianUint16(bytes, offset) {
    return offset + 2 <= bytes.length ? (bytes[offset] << 8) | bytes[offset + 1] : 0;
  }

  function readEndianUint16(bytes, offset, littleEndian) {
    if (offset + 2 > bytes.length) return 0;
    return littleEndian ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readEndianUint32(bytes, offset, littleEndian) {
    if (offset + 4 > bytes.length) return 0;
    return littleEndian
      ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0
      : ((bytes[offset] * 0x1000000) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function writeExifOrientation(bytes, offset, littleEndian, value) {
    if (offset < 0 || offset + 2 > bytes.length) return;
    if (littleEndian) {
      bytes[offset] = value & 0xff;
      bytes[offset + 1] = value >> 8;
    } else {
      bytes[offset] = value >> 8;
      bytes[offset + 1] = value & 0xff;
    }
  }

  function orientedImageSize(width, height, orientation) {
    return orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  }

  async function resizePhoto(bitmap, maxDimension, targetBytes, initialQuality, orientation = 1) {
    const sourceSize = orientedImageSize(bitmap.width, bitmap.height, orientation);
    const ratio = Math.min(1, maxDimension / Math.max(sourceSize.width, sourceSize.height));
    const width = Math.max(1, Math.round(sourceSize.width * ratio));
    const height = Math.max(1, Math.round(sourceSize.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    drawOrientedImage(context, bitmap, orientation, width / sourceSize.width, height / sourceSize.height);
    let quality = initialQuality;
    let blob = await canvasToBlob(canvas, quality);
    while (blob.size > targetBytes && quality > 0.5) {
      quality -= 0.08;
      blob = await canvasToBlob(canvas, quality);
    }
    return blob;
  }

  function drawOrientedImage(context, bitmap, orientation, scaleX, scaleY) {
    const width = bitmap.width;
    const height = bitmap.height;
    switch (orientation) {
      case 2: context.setTransform(-scaleX, 0, 0, scaleY, width * scaleX, 0); break;
      case 3: context.setTransform(-scaleX, 0, 0, -scaleY, width * scaleX, height * scaleY); break;
      case 4: context.setTransform(scaleX, 0, 0, -scaleY, 0, height * scaleY); break;
      case 5: context.setTransform(0, scaleY, scaleX, 0, 0, 0); break;
      case 6: context.setTransform(0, scaleY, -scaleX, 0, height * scaleX, 0); break;
      case 7: context.setTransform(0, -scaleY, -scaleX, 0, height * scaleX, width * scaleY); break;
      case 8: context.setTransform(0, -scaleY, scaleX, 0, 0, width * scaleY); break;
      default: context.setTransform(scaleX, 0, 0, scaleY, 0, 0); break;
    }
    context.drawImage(bitmap, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を変換できませんでした。")), "image/webp", quality);
    });
  }

  function insertPhotoMarker(id) {
    insertPhotoMarkersAtOffset([id], getEditorSelectionOffset("end"));
  }

  function insertPhotoMarkersAtOffset(ids, requestedOffset) {
    if (!ids.length) return false;
    const editorDocument = serializeRichEditor(false);
    const content = editorDocument.content;
    const offset = Math.max(0, Math.min(content.length, Number(requestedOffset) || 0));
    const prefix = offset > 0 && content[offset - 1] !== "\n" ? "\n" : "";
    const suffix = offset < content.length && content[offset] !== "\n" ? "\n" : "";
    const insertedText = `${prefix}${ids.map(photoMarker).join("")}${suffix}`;
    if (content.length + insertedText.length > 200000) {
      elements.editorMessage.textContent = "本文は20万文字以内で入力してください。";
      return false;
    }
    const updatedDocument = insertTextIntoRichDocument(editorDocument, offset, insertedText);
    setRichEditorDocument(updatedDocument.content, updatedDocument.contentFormat);
    elements.entryContent.focus({ preventScroll: true });
    const caret = offset + insertedText.length;
    restoreEditorSelectionFromOffsets({ start: caret, end: caret });
    state.editorSelectionOffsets = null;
    elements.entryContent.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function handleRichEditorInput() {
    state.editorDirty = true;
    if (state.editorToolbarOpen) closeEntryFormatToolbar();
  }

  function handleRichEditorCompositionStart() {
    state.editorComposing = true;
  }

  function handleRichEditorCompositionEnd() {
    state.editorComposing = false;
  }

  function waitForEditorCompositionEnd() {
    if (!state.editorComposing) return Promise.resolve();
    return new Promise((resolve) => {
      elements.entryContent.addEventListener("compositionend", () => {
        window.setTimeout(resolve, 0);
      }, { once: true });
    });
  }

  function handleRichEditorBeforeInput(event) {
    if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
      if (!canInsertEditorText("\n")) {
        event.preventDefault();
        elements.editorMessage.textContent = "本文は20万文字以内で入力してください。";
      }
      return;
    }
    if (event.inputType.startsWith("insert") && event.data && !canInsertEditorText(event.data)) {
      event.preventDefault();
      elements.editorMessage.textContent = "本文は20万文字以内で入力してください。";
    }
  }

  function handleRichEditorPaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text) insertPlainTextAtEditorSelection(text.replace(/\r\n?/g, "\n"));
  }

  function handleRichEditorKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const command = ({ b: "bold", i: "italic", u: "underline" })[event.key.toLowerCase()];
    if (!command) return;
    event.preventDefault();
    applyEntryFormat(command);
  }

  function handleRichEditorPointerDown() {
    if (state.editorToolbarOpen) closeEntryFormatToolbar();
    state.editorSelectionOffsets = null;
  }

  function preserveEditorSelectionFromToolbar() {
    rememberEditorSelection();
    captureEditorSelectionOffsets();
  }

  function toggleEntryFormatToolbar() {
    const open = elements.entryFormatToolbar.hidden;
    if (open && !hasSelectedEditorText()) {
      closeEntryFormatToolbar();
      elements.editorMessage.textContent = "書式を変更する文字を選択してください。";
      return;
    }
    elements.editorMessage.textContent = "";
    elements.entryFormatToolbar.hidden = !open;
    elements.entryFormatToggle.setAttribute("aria-expanded", String(open));
    elements.entryContentShell.classList.toggle("is-formatting", open);
    state.editorToolbarOpen = open;
    updateEditorKeyboardOffset();
    updateFormattingToolbarState();
  }

  function closeEntryFormatToolbar() {
    elements.entryFormatToolbar.hidden = true;
    elements.entryFormatToggle.setAttribute("aria-expanded", "false");
    elements.entryContentShell.classList.remove("is-formatting");
    state.editorToolbarOpen = false;
  }

  function handleEntryFormatAction(event) {
    const colorButton = event.target.closest("[data-format-color]");
    if (colorButton) {
      applyEntryFormat("color", colorButton.dataset.formatColor);
      return;
    }
    const commandButton = event.target.closest("[data-format-command]");
    if (commandButton) applyEntryFormat(commandButton.dataset.formatCommand);
  }

  function applyEntryFormat(command, value = null) {
    const offsets = state.editorSelectionOffsets || captureEditorSelectionOffsets();
    if (!offsets || offsets.end <= offsets.start) {
      closeEntryFormatToolbar();
      elements.editorMessage.textContent = "書式を変更する文字を選択してください。";
      return;
    }
    const editorDocument = serializeRichEditor(false);
    const runs = applyFormatToSelection(
      editorDocument.content.length,
      editorDocument.contentFormat?.runs || [],
      offsets.start,
      offsets.end,
      command,
      value
    );
    setRichEditorDocument(editorDocument.content, runs.length ? { version: 1, runs } : null);
    restoreEditorSelectionFromOffsets(offsets);
    state.editorDirty = true;
    state.editorSelectionOffsets = offsets;
    updateFormattingToolbarState();
  }

  function rememberEditorSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!elements.entryContent.contains(range.commonAncestorContainer)) return;
    state.editorSelection = range.cloneRange();
    if (!state.editorToolbarOpen) state.editorSelectionOffsets = null;
    if (state.editorToolbarOpen) updateFormattingToolbarState();
  }

  function restoreEditorSelection() {
    elements.entryContent.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (state.editorSelection && elements.entryContent.contains(state.editorSelection.commonAncestorContainer)) {
      selection.addRange(state.editorSelection);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(elements.entryContent);
    range.collapse(false);
    selection.addRange(range);
    state.editorSelection = range.cloneRange();
  }

  function getEditorSelectionOffset(boundary = "start") {
    const range = state.editorSelection;
    if (!range || !elements.entryContent.contains(range.startContainer)) return getRichEditorPlainText().length;
    const offsets = getSerializedEditorRangeOffsets(range);
    if (!offsets) return getRichEditorPlainText().length;
    return boundary === "end" ? offsets.end : offsets.start;
  }

  function captureEditorSelectionOffsets() {
    const range = state.editorSelection;
    if (!range || range.collapsed || !elements.entryContent.contains(range.commonAncestorContainer)) {
      state.editorSelectionOffsets = null;
      return null;
    }
    const offsets = getSerializedEditorRangeOffsets(range);
    if (!offsets || offsets.end <= offsets.start) {
      state.editorSelectionOffsets = null;
      return null;
    }
    state.editorSelectionOffsets = offsets;
    return state.editorSelectionOffsets;
  }

  function getSerializedEditorRangeOffsets(range) {
    if (!range || !elements.entryContent.contains(range.startContainer)
      || !elements.entryContent.contains(range.endContainer)) return null;
    const startPath = getEditorNodePath(range.startContainer);
    const endPath = getEditorNodePath(range.endContainer);
    if (!startPath || !endPath) return null;
    const editorClone = elements.entryContent.cloneNode(true);
    const startContainer = getNodeAtPath(editorClone, startPath);
    const endContainer = getNodeAtPath(editorClone, endPath);
    if (!startContainer || !endContainer) return null;
    const nonce = crypto.randomUUID();
    const startToken = `\ue000${nonce}:start\ue001`;
    const endToken = `\ue000${nonce}:end\ue001`;
    const startMarker = document.createElement("span");
    const endMarker = document.createElement("span");
    startMarker.textContent = startToken;
    endMarker.textContent = endToken;
    const endBoundary = document.createRange();
    endBoundary.setStart(endContainer, range.endOffset);
    endBoundary.collapse(true);
    endBoundary.insertNode(endMarker);
    const startBoundary = document.createRange();
    startBoundary.setStart(startContainer, range.startOffset);
    startBoundary.collapse(true);
    startBoundary.insertNode(startMarker);
    const contentWithMarkers = serializeRichEditorRoot(editorClone, false).content;
    const startIndex = contentWithMarkers.indexOf(startToken);
    const endIndex = contentWithMarkers.indexOf(endToken);
    if (startIndex < 0 || endIndex < startIndex + startToken.length) return null;
    return { start: startIndex, end: endIndex - startToken.length };
  }

  function getEditorNodePath(node) {
    const path = [];
    let current = node;
    while (current && current !== elements.entryContent) {
      const parent = current.parentNode;
      if (!parent) return null;
      const index = [...parent.childNodes].indexOf(current);
      if (index < 0) return null;
      path.unshift(index);
      current = parent;
    }
    return current === elements.entryContent ? path : null;
  }

  function getNodeAtPath(root, path) {
    let current = root;
    for (const index of path) {
      current = current?.childNodes?.[index];
      if (!current) return null;
    }
    return current;
  }

  function hasSelectedEditorText() {
    const offsets = state.editorSelectionOffsets || captureEditorSelectionOffsets();
    return Boolean(offsets && offsets.end > offsets.start);
  }

  function restoreEditorSelectionFromOffsets(offsets) {
    const locate = (requestedOffset) => {
      const walker = document.createTreeWalker(elements.entryContent, NodeFilter.SHOW_TEXT);
      const maximum = getRichEditorPlainText().length;
      let remaining = Math.max(0, Math.min(maximum, requestedOffset));
      let node = walker.nextNode();
      let lastNode = null;
      while (node) {
        lastNode = node;
        if (remaining <= node.nodeValue.length) return { node, offset: remaining };
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return lastNode
        ? { node: lastNode, offset: lastNode.nodeValue.length }
        : { node: elements.entryContent, offset: 0 };
    };
    const start = locate(offsets.start);
    const end = locate(offsets.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    state.editorSelection = range.cloneRange();
  }

  function insertPlainTextAtEditorSelection(text) {
    if (!canInsertEditorText(text)) {
      elements.editorMessage.textContent = "本文は20万文字以内で入力してください。";
      return false;
    }
    restoreEditorSelection();
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    state.editorSelection = range.cloneRange();
    elements.entryContent.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function canInsertEditorText(text) {
    const selection = window.getSelection();
    const selectedLength = selection?.rangeCount && elements.entryContent.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).toString().replace(/[\u200b\ufeff]/g, "").length
      : 0;
    return getRichEditorPlainText().length - selectedLength + String(text || "").length <= 200000;
  }

  function updateFormattingToolbarState() {
    if (!elements.entryFormatToolbar) return;
    const offsets = state.editorSelectionOffsets;
    const editorDocument = serializeRichEditor(false);
    const formatState = getSelectionFormatState(
      editorDocument.content.length,
      editorDocument.contentFormat?.runs || [],
      offsets?.start,
      offsets?.end
    );
    for (const command of ["bold", "italic", "underline"]) {
      const button = elements.entryFormatToolbar.querySelector(`[data-format-command="${command}"]`);
      button?.setAttribute("aria-pressed", String(Boolean(formatState?.[command])));
    }
    elements.entryFormatToolbar.querySelectorAll("[data-format-color]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.formatColor === formatState?.color));
    });
  }

  function getSelectionSegments(contentLength, runs, start, end) {
    const selectionStart = Math.max(0, Math.min(contentLength, Number(start) || 0));
    const selectionEnd = Math.max(selectionStart, Math.min(contentLength, Number(end) || 0));
    const boundaries = new Set([0, contentLength, selectionStart, selectionEnd]);
    for (const run of runs) {
      boundaries.add(Math.max(0, Math.min(contentLength, Number(run.start) || 0)));
      boundaries.add(Math.max(0, Math.min(contentLength, Number(run.end) || 0)));
    }
    const points = [...boundaries].sort((left, right) => left - right);
    return points.slice(0, -1).flatMap((segmentStart, index) => {
      const segmentEnd = points[index + 1];
      if (segmentEnd <= segmentStart) return [];
      const run = runs.find((candidate) => candidate.start <= segmentStart && candidate.end >= segmentEnd);
      return [{
        start: segmentStart,
        end: segmentEnd,
        selected: segmentStart >= selectionStart && segmentEnd <= selectionEnd,
        bold: Boolean(run?.bold),
        italic: Boolean(run?.italic),
        underline: Boolean(run?.underline),
        color: run?.color || null
      }];
    });
  }

  function getSelectionFormatState(contentLength, runs, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const selected = getSelectionSegments(contentLength, runs, start, end).filter((segment) => segment.selected);
    if (!selected.length) return null;
    const colors = new Set(selected.map((segment) => segment.color || "default"));
    return {
      bold: selected.every((segment) => segment.bold),
      italic: selected.every((segment) => segment.italic),
      underline: selected.every((segment) => segment.underline),
      color: colors.size === 1 ? [...colors][0] : null
    };
  }

  function applyFormatToSelection(contentLength, runs, start, end, command, value) {
    const segments = getSelectionSegments(contentLength, runs, start, end);
    const selected = segments.filter((segment) => segment.selected);
    const enableCommand = ["bold", "italic", "underline"].includes(command)
      ? !selected.every((segment) => segment[command])
      : false;
    return mergeRichTextRuns(segments.map((segment) => {
      const marks = {
        start: segment.start,
        end: segment.end,
        bold: segment.bold,
        italic: segment.italic,
        underline: segment.underline,
        color: segment.color
      };
      if (segment.selected && command === "color") marks.color = value === "default" ? null : value;
      if (segment.selected && ["bold", "italic", "underline"].includes(command)) marks[command] = enableCommand;
      return marks;
    }));
  }

  function updateEditorKeyboardOffset() {
    const viewport = window.visualViewport;
    const offset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    elements.entryContentShell?.style.setProperty("--editor-keyboard-offset", `${Math.round(offset)}px`);
  }

  function handleEditorViewportChange() {
    updateEditorKeyboardOffset();
    positionEntryTagSuggestions();
  }

  function richColorKey(value) {
    const normalized = String(value || "").toLowerCase().replace(/\s+/g, "");
    for (const [key, hex] of Object.entries(RICH_TEXT_COLORS)) {
      if (key === "default") continue;
      const rgb = hexToRgb(hex);
      if (normalized === hex || normalized === `rgb(${rgb.join(",")})`) return key;
    }
    return null;
  }

  function hexToRgb(value) {
    const normalized = value.replace("#", "");
    return [0, 2, 4].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16));
  }

  function getRichEditorPlainText() {
    return serializeRichEditor(false).content;
  }


  function serializeRichEditor(trim = true) {
    return serializeRichEditorRoot(elements.entryContent, trim);
  }

  function serializeRichEditorRoot(root, trim = true) {
    const chunks = [];
    collectRichEditorChunks(root, chunks);
    let content = chunks.map((chunk) => chunk.text).join("").replace(/\u00a0/g, " ");
    let offset = 0;
    const runs = [];
    for (const chunk of chunks) {
      const length = chunk.text.length;
      if (length && hasTextMarks(chunk.marks)) {
        runs.push({ start: offset, end: offset + length, ...chunk.marks });
      }
      offset += length;
    }
    let normalizedRuns = mergeRichTextRuns(runs);
    if (trim && content) {
      const leading = content.search(/\S/);
      const trailing = content.length - content.trimEnd().length;
      const start = leading < 0 ? content.length : leading;
      const end = content.length - trailing;
      content = content.slice(start, end);
      normalizedRuns = normalizedRuns.flatMap((run) => {
        const runStart = Math.max(run.start, start);
        const runEnd = Math.min(run.end, end);
        return runEnd > runStart ? [{ ...run, start: runStart - start, end: runEnd - start }] : [];
      });
    }
    return {
      content,
      contentFormat: normalizedRuns.length ? { version: 1, runs: mergeRichTextRuns(normalizedRuns) } : null
    };
  }

  function collectRichEditorChunks(root, chunks) {
    const blockTags = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "BLOCKQUOTE"]);
    const append = (text, marks) => {
      if (!text) return;
      const previous = chunks.at(-1);
      if (previous && sameTextMarks(previous.marks, marks)) previous.text += text;
      else chunks.push({ text, marks });
    };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement || root;
        const style = getComputedStyle(parent);
        append((node.nodeValue || "").replace(/[\u200b\ufeff]/g, ""), {
          bold: Number.parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === "bold",
          italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
          underline: style.textDecorationLine.includes("underline"),
          color: richColorKey(style.color)
        });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        append("\n", marksForElement(node.parentElement || root));
        return;
      }
      const isBlock = node !== root && blockTags.has(node.tagName);
      if (isBlock && chunks.length && !chunks.at(-1).text.endsWith("\n")) append("\n", marksForElement(node));
      [...node.childNodes].forEach(visit);
      if (isBlock && node.nextSibling && !chunks.at(-1)?.text.endsWith("\n")) append("\n", marksForElement(node));
    };
    [...root.childNodes].forEach(visit);
  }

  function marksForElement(element) {
    const style = getComputedStyle(element);
    return {
      bold: Number.parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === "bold",
      italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
      underline: style.textDecorationLine.includes("underline"),
      color: richColorKey(style.color)
    };
  }

  function hasTextMarks(marks) {
    return Boolean(marks.bold || marks.italic || marks.underline || marks.color);
  }

  function sameTextMarks(left, right) {
    return Boolean(left?.bold) === Boolean(right?.bold)
      && Boolean(left?.italic) === Boolean(right?.italic)
      && Boolean(left?.underline) === Boolean(right?.underline)
      && (left?.color || null) === (right?.color || null);
  }

  function mergeRichTextRuns(runs) {
    const merged = [];
    for (const run of runs) {
      if (run.end <= run.start || !hasTextMarks(run)) continue;
      const previous = merged.at(-1);
      if (previous && previous.end === run.start && sameTextMarks(previous, run)) previous.end = run.end;
      else merged.push({
        start: run.start,
        end: run.end,
        bold: Boolean(run.bold),
        italic: Boolean(run.italic),
        underline: Boolean(run.underline),
        color: run.color || null
      });
    }
    return merged;
  }

  function shiftRichTextRunsForInsertion(runs, offset, insertedLength) {
    return mergeRichTextRuns(runs.flatMap((run) => {
      if (run.end <= offset) return [run];
      if (run.start >= offset) {
        return [{ ...run, start: run.start + insertedLength, end: run.end + insertedLength }];
      }
      return [
        { ...run, end: offset },
        { ...run, start: offset + insertedLength, end: run.end + insertedLength }
      ];
    }));
  }

  function insertTextIntoRichDocument(documentValue, requestedOffset, insertedText) {
    const content = String(documentValue?.content || "");
    const offset = Math.max(0, Math.min(content.length, Number(requestedOffset) || 0));
    const text = String(insertedText || "");
    const runs = shiftRichTextRunsForInsertion(
      Array.isArray(documentValue?.contentFormat?.runs) ? documentValue.contentFormat.runs : [],
      offset,
      text.length
    );
    return {
      content: content.slice(0, offset) + text + content.slice(offset),
      contentFormat: runs.length ? { version: 1, runs } : null
    };
  }

  function setRichEditorDocument(content, contentFormat = null) {
    const text = String(content || "");
    const runs = Array.isArray(contentFormat?.runs) ? contentFormat.runs : [];
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const run of runs) {
      const start = Math.max(cursor, Math.min(text.length, Number(run.start) || 0));
      const end = Math.max(start, Math.min(text.length, Number(run.end) || 0));
      if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
      if (end > start) fragment.append(createFormattedTextSpan(text.slice(start, end), run));
      cursor = end;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    elements.entryContent.replaceChildren(fragment);
    state.editorSelection = null;
    state.editorSelectionOffsets = null;
  }

  function createFormattedTextSpan(text, marks) {
    const span = document.createElement("span");
    span.textContent = text;
    if (marks.bold) span.classList.add("diary-text-bold");
    if (marks.italic) span.classList.add("diary-text-italic");
    if (marks.underline) span.classList.add("diary-text-underline");
    if (marks.color && RICH_TEXT_COLORS[marks.color]) span.classList.add(`diary-text-color-${marks.color}`);
    return span;
  }

  function removePhotoMarkerFromEditor(marker) {
    const documentValue = removeTextFromRichDocument(serializeRichEditor(false), marker);
    setRichEditorDocument(documentValue.content, documentValue.contentFormat);
  }

  function removeTextFromRichDocument(documentValue, textToRemove) {
    let content = documentValue.content;
    let runs = documentValue.contentFormat?.runs || [];
    let index = content.lastIndexOf(textToRemove);
    while (index >= 0) {
      const end = index + textToRemove.length;
      content = content.slice(0, index) + content.slice(end);
      runs = runs.flatMap((run) => {
        if (run.end <= index) return [run];
        if (run.start >= end) return [{ ...run, start: run.start - textToRemove.length, end: run.end - textToRemove.length }];
        const newStart = run.start < index ? run.start : index;
        const newEnd = run.end > end ? run.end - textToRemove.length : index;
        return newEnd > newStart ? [{ ...run, start: newStart, end: newEnd }] : [];
      });
      index = content.lastIndexOf(textToRemove, index - 1);
    }
    return {
      content,
      contentFormat: runs.length ? { version: 1, runs: mergeRichTextRuns(runs) } : null
    };
  }

  function withoutPhotoMarkers(documentValue, photoIds) {
    const withoutMarkers = photoIds.reduce(
      (current, photoId) => removeTextFromRichDocument(current, photoMarker(photoId)),
      documentValue
    );
    const content = withoutMarkers.content;
    if (!content) return withoutMarkers;
    const leading = content.search(/\S/);
    const trailing = content.length - content.trimEnd().length;
    const start = leading < 0 ? content.length : leading;
    const end = content.length - trailing;
    const runs = (withoutMarkers.contentFormat?.runs || []).flatMap((run) => {
      const runStart = Math.max(run.start, start);
      const runEnd = Math.min(run.end, end);
      return runEnd > runStart ? [{ ...run, start: runStart - start, end: runEnd - start }] : [];
    });
    return {
      content: content.slice(start, end),
      contentFormat: runs.length ? { version: 1, runs: mergeRichTextRuns(runs) } : null
    };
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
      const markerPresent = getRichEditorPlainText().includes(photoMarker(photo.id));
      const insert = document.createElement("button");
      insert.className = "quiet-button";
      insert.type = "button";
      insert.dataset.photoAction = "insert";
      insert.dataset.photoId = photo.id;
      insert.textContent = markerPresent ? "挿入済み" : "本文へ挿入";
      insert.disabled = markerPresent;
      actions.append(insert);
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.dataset.photoAction = "remove";
      remove.dataset.photoId = photo.id;
      remove.textContent = photo.existing ? "削除" : "取り除く";
      actions.append(remove);
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
    if (button.dataset.photoAction === "remove") {
      if (photo.existing && !window.confirm("この画像を日記から削除しますか？保存するまで削除は確定しません。")) return;
      removePhotoMarkerFromEditor(photoMarker(photo.id));
      if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
      if (photo.existing) state.editorDeletedPhotoIds.add(photo.id);
      else void deleteStagedPhotoUpload(photo).catch(() => {
        elements.photoPreparationStatus.textContent = "一時保存した画像は後ほど自動的に削除されます。";
      });
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
    state.editorDeletedPhotoIds.clear();
    state.photoUploadSessionId = null;
    state.photoUploadSessionPromise = null;
    state.photoUploadTargetEntryId = null;
    state.photoUploadCommitted = false;
    state.photoUploadPendingCount = 0;
    state.photoUploading = false;
    state.photoUploadActiveTasks.clear();
    elements.editorPhotoList?.replaceChildren();
  }

  function createPhotoUploadForm(photo) {
    const form = new FormData();
    form.set("id", photo.id);
    form.set("width", String(photo.width || ""));
    form.set("height", String(photo.height || ""));
    form.set("original", photo.originalFile, photo.fileName);
    form.set("display", photo.displayBlob, "display.webp");
    form.set("thumbnail", photo.thumbnailBlob, "thumbnail.webp");
    return form;
  }

  function waitForPhotoUploadRetry(attemptIndex) {
    return new Promise((resolve) => window.setTimeout(resolve, PHOTO_UPLOAD_RETRY_DELAYS_MS[attemptIndex]));
  }

  function logPhotoUploadRetry(uploadTarget, photoId, attempt, details) {
    console.warn("Diary photo upload retry", {
      stage: "photo-upload",
      uploadTarget,
      photoId,
      retry: attempt,
      ...details
    });
  }

  async function ensurePhotoUploadSession() {
    if (state.photoUploadSessionId) return state.photoUploadSessionId;
    if (state.photoUploadSessionPromise) return state.photoUploadSessionPromise;
    const targetEntryId = Number(elements.entryId.value || 0) || null;
    state.photoUploadTargetEntryId = targetEntryId;
    state.photoUploadSessionPromise = api("/photo-upload-sessions", {
      method: "POST",
      body: { targetEntryId }
    }).then((result) => {
      state.photoUploadSessionId = result.uploadSession.id;
      return state.photoUploadSessionId;
    }).finally(() => {
      state.photoUploadSessionPromise = null;
    });
    return state.photoUploadSessionPromise;
  }

  function queueBackgroundPhotoUpload(photo) {
    if (photo.existing || photo.removed || photo.uploadState === "uploaded") return Promise.resolve(photo);
    if (photo.uploadPromise) return photo.uploadPromise;
    photo.uploadState = "uploading";
    photo.uploadError = null;
    state.photoUploadPendingCount += 1;
    state.photoUploading = true;
    const queued = (async () => {
      while (state.photoUploadActiveTasks.size >= PHOTO_UPLOAD_CONCURRENCY) {
        await Promise.race(state.photoUploadActiveTasks);
      }
      if (photo.removed) return null;
      const activeTask = uploadPhotoToStaging(photo);
      const settledTask = activeTask.catch(() => null);
      state.photoUploadActiveTasks.add(settledTask);
      try {
        const result = await activeTask;
        photo.uploadState = "uploaded";
        photo.uploadError = null;
        if (photo.removed) await deleteStagedPhotoUpload(photo, { waitForUpload: false });
        return result;
      } catch (error) {
        photo.uploadState = "failed";
        photo.uploadError = error;
        return null;
      } finally {
        state.photoUploadActiveTasks.delete(settledTask);
      }
    })();
    photo.uploadPromise = queued.finally(() => {
      photo.uploadPromise = null;
      state.photoUploadPendingCount = Math.max(0, state.photoUploadPendingCount - 1);
      state.photoUploading = state.photoUploadPendingCount > 0;
    });
    return photo.uploadPromise;
  }

  async function uploadPhotoToStaging(photo) {
    const uploadSessionId = await ensurePhotoUploadSession();
    const maxAttempts = PHOTO_UPLOAD_RETRY_DELAYS_MS.length + 1;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(`${BASE_PATH}/api/photo-upload-sessions/${uploadSessionId}/photos`, {
          method: "POST",
          headers: { "X-Diary-Request": "1" },
          credentials: "same-origin",
          body: createPhotoUploadForm(photo)
        });
      } catch {
        lastError = new Error("画像の通信に失敗しました。");
        if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
        logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "network" });
        await waitForPhotoUploadRetry(attempt);
        continue;
      }

      let result;
      try {
        result = await response.json();
      } catch {
        result = {};
        if (response.ok) {
          lastError = new Error("画像の保存結果を確認できませんでした。");
          if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
          logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "invalid-response", status: response.status });
          await waitForPhotoUploadRetry(attempt);
          continue;
        }
      }

      if (response.ok && result?.photo?.id === photo.id) return result;
      if (response.ok) {
        lastError = new Error("画像の保存結果を確認できませんでした。");
        if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
        logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "invalid-response", status: response.status });
        await waitForPhotoUploadRetry(attempt);
        continue;
      }

      lastError = new Error(result.error || "画像を保存できませんでした。");
      if (response.status < 500 || response.status > 599 || attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) {
        throw lastError;
      }
      logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "http", status: response.status });
      await waitForPhotoUploadRetry(attempt);
    }
    throw lastError || new Error("画像を保存できませんでした。");
  }

  async function ensurePhotosUploaded(photos) {
    await Promise.all(photos.map((photo) => photo.uploadPromise || Promise.resolve()));
    const failed = photos.filter((photo) => photo.uploadState !== "uploaded");
    if (failed.length) {
      await Promise.all(failed.map((photo) => queueBackgroundPhotoUpload(photo)));
    }
    const remaining = photos.filter((photo) => photo.uploadState !== "uploaded");
    if (remaining.length) {
      throw new Error(remaining.map((photo) => `${photo.fileName}：${photo.uploadError?.message || "画像を保存できませんでした。"}`).join(" / "));
    }
  }

  async function deleteStagedPhotoUpload(photo, { waitForUpload = true } = {}) {
    photo.removed = true;
    if (waitForUpload && photo.uploadPromise) await photo.uploadPromise;
    if (photo.uploadState !== "uploaded" || !state.photoUploadSessionId) return;
    state.photoUploadPendingCount += 1;
    state.photoUploading = true;
    try {
      const response = await fetch(`${BASE_PATH}/api/photo-upload-sessions/${state.photoUploadSessionId}/photos/${photo.id}`, {
        method: "DELETE",
        headers: { "X-Diary-Request": "1" },
        credentials: "same-origin",
        keepalive: true
      });
      if (!response.ok) throw new Error("一時保存した画像を削除できませんでした。");
      photo.uploadState = "removed";
    } finally {
      state.photoUploadPendingCount = Math.max(0, state.photoUploadPendingCount - 1);
      state.photoUploading = state.photoUploadPendingCount > 0;
    }
  }

  async function commitStagedPhotos(entryId, photos) {
    if (!state.photoUploadSessionId) return [];
    const result = await api(`/photo-upload-sessions/${state.photoUploadSessionId}/commit`, {
      method: "POST",
      body: { entryId, photoIds: photos.map((photo) => photo.id) }
    });
    state.photoUploadCommitted = true;
    return result.photos || [];
  }

  async function cancelEditorPhotoUploadSession() {
    if (!state.photoUploadSessionId && state.photoUploadSessionPromise) {
      await state.photoUploadSessionPromise.catch(() => null);
    }
    const uploadSessionId = state.photoUploadSessionId;
    if (!uploadSessionId || state.photoUploadCommitted) return;
    await Promise.allSettled([
      ...state.photoUploadActiveTasks,
      ...state.editorPhotos.map((photo) => photo.uploadPromise).filter(Boolean)
    ]);
    try {
      await fetch(`${BASE_PATH}/api/photo-upload-sessions/${uploadSessionId}`, {
        method: "DELETE",
        headers: { "X-Diary-Request": "1" },
        credentials: "same-origin",
        keepalive: true
      });
    } catch {
      // The server-side expiry cleanup removes abandoned staging data.
    }
  }

  async function deletePhoto(photoId) {
    const response = await fetch(`${BASE_PATH}/api/photos/${photoId}`, {
      method: "DELETE",
      headers: { "X-Diary-Request": "1" },
      credentials: "same-origin"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "画像を削除できませんでした。");
    return result;
  }

  function openEditor(entry = null) {
    if (!state.canManageEntries) return;
    const isDraft = entry?.status === "draft";
    elements.editorMessage.textContent = "";
    elements.editorTitle.textContent = isDraft ? "下書きを編集" : (entry ? "日記を編集" : "新しい日記");
    elements.entryId.value = entry ? String(entry.id) : "";
    elements.entryRevision.value = entry ? String(entry.revision) : "";
    elements.entryStatus.value = isDraft ? "draft" : "published";
    elements.entryDate.value = entry?.entryDate || japanDateString();
    elements.entryTitle.value = entry?.title || "";
    state.editorSelectionOffsets = null;
    state.editorComposing = false;
    state.photoInsertionOffset = null;
    setRichEditorDocument(entry?.content || "", entry?.contentFormat || null);
    elements.entryTags.value = entry?.tags?.join("、") || "";
    closeEntryTagSuggestions();
    clearEditorPhotos();
    state.editorSourceEntry = entry ? structuredClone(entry) : null;
    state.entryCreateRequestId = entry ? null : crypto.randomUUID().toLowerCase();
    state.editorDeletedPhotoIds = new Set(entry?.excludedPhotoIds || []);
    state.editorPhotos = (entry?.photos || []).map((photo) => ({ ...photo, existing: true }));
    elements.photoPreparationStatus.textContent = "";
    renderEditorPhotos();
    state.editorDirty = false;
    closeEntryFormatToolbar();
    elements.editorDialog.showModal();
    pushEditorHistory();
    updateEditorKeyboardOffset();
    window.setTimeout(() => elements.entryTitle.focus(), 0);
  }

  function postEntry(event) {
    event.preventDefault();
    persistEditor("published");
  }

  function saveEntryAsDraft({ closeAfter = false } = {}) {
    return persistEditor("draft", { closeAfter });
  }

  async function persistEditor(targetStatus, { closeAfter = false } = {}) {
    elements.editorMessage.textContent = "";
    setEditorSaveBusy(true, targetStatus === "draft" ? "下書き保存中..." : "投稿中...");
    try {
      await waitForPhotoPreparation();
      const id = Number(elements.entryId.value || 0);
      const editorDocument = serializeRichEditor(true);
      const body = {
        entryDate: elements.entryDate.value,
        title: elements.entryTitle.value,
        content: editorDocument.content,
        contentFormat: editorDocument.contentFormat,
        tags: parseTags(elements.entryTags.value),
        status: targetStatus,
        excludedPhotoIds: [...state.editorDeletedPhotoIds]
      };
      if (id) body.revision = Number(elements.entryRevision.value);
      else body.requestId = state.entryCreateRequestId || (state.entryCreateRequestId = crypto.randomUUID().toLowerCase());

      const pendingPhotos = state.editorPhotos.filter((photo) => !photo.existing && body.content.includes(photoMarker(photo.id)));
      if (pendingPhotos.length) {
        setEditorSaveBusy(true, "写真の保存完了を待っています...");
        await ensurePhotosUploaded(pendingPhotos);
      }

      const sourceEntry = state.editorSourceEntry;
      const provisionalDocument = pendingPhotos.length
        ? withoutPhotoMarkers(editorDocument, pendingPhotos.map((photo) => photo.id))
        : editorDocument;
      const provisionalBody = pendingPhotos.length ? {
        ...body,
        content: provisionalDocument.content,
        contentFormat: provisionalDocument.contentFormat,
        pendingPhotoIds: pendingPhotos.map((photo) => photo.id),
        photoUploadSessionId: state.photoUploadSessionId
      } : body;
      let saved = id
        ? await api(`/entries/${id}`, { method: "PUT", body: provisionalBody })
        : await createEntryIdempotently(provisionalBody);
      const failures = [];
      const deletedPhotoIds = [...state.editorDeletedPhotoIds];
      const promotedEditDraft = targetStatus === "published"
        && elements.entryStatus.value === "draft"
        && Boolean(sourceEntry?.draftOfEntryId);
      const photoOwners = new Map((sourceEntry?.photos || []).map((photo) => [photo.id, Number(photo.entryId)]));
      elements.entryId.value = String(saved.entry.id);
      elements.entryRevision.value = String(saved.entry.revision);
      elements.entryStatus.value = saved.entry.status;
      state.editorSourceEntry = saved.entry;
      const deletionsToApply = promotedEditDraft
        ? []
        : deletedPhotoIds.filter((photoId) => targetStatus === "published" || photoOwners.get(photoId) === saved.entry.id);
      for (let index = 0; index < deletionsToApply.length; index += 1) {
        const photoId = deletionsToApply[index];
        setEditorSaveBusy(true, `画像を削除中 ${index + 1}/${deletionsToApply.length}`);
        try {
          await deletePhoto(photoId);
          state.editorDeletedPhotoIds.delete(photoId);
        } catch (error) {
          failures.push(`画像の削除：${error.message}`);
        }
      }
      if (state.photoUploadSessionId && !state.photoUploadCommitted) {
        setEditorSaveBusy(true, "写真を日記へ反映しています...");
        try {
          const committedPhotos = await commitStagedPhotos(saved.entry.id, pendingPhotos);
          const committedById = new Map(committedPhotos.map((photo) => [photo.id, photo]));
          for (const photo of pendingPhotos) {
            photo.existing = true;
            Object.assign(photo, committedById.get(photo.id) || {});
          }
          if (pendingPhotos.length) {
            setEditorSaveBusy(true, "写真を本文へ反映しています...");
            saved = await finalizeCommittedPhotoEntry(saved.entry.id, body, saved.entry);
            elements.entryRevision.value = String(saved.entry.revision);
            elements.entryStatus.value = saved.entry.status;
            state.editorSourceEntry = saved.entry;
          }
        } catch (error) {
          failures.push(`写真の反映：${error.message}`);
        }
      }
      if (failures.length) {
        elements.editorMessage.textContent = `${targetStatus === "draft" ? "下書き" : "日記本文"}は保存しました。写真を保存できませんでした。${failures.join(" / ")}`;
        renderEditorPhotos();
        return false;
      }
      state.editorDirty = false;
      if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
      const promotedDraft = targetStatus === "published" && elements.entryStatus.value === "draft";
      showToast(targetStatus === "draft" ? "下書きを保存しました。" : (promotedDraft || !id ? "日記を投稿しました。" : "日記を更新しました。"));
      state.trash = false;
      if (targetStatus === "published") state.drafts = false;
      else if (!closeAfter) state.drafts = true;
      updateFilterControls();
      closeEditorDialog();
      await Promise.all([loadMeta(), loadEntries(true)]);
      return true;
    } catch (error) {
      elements.editorMessage.textContent = error.message;
      return false;
    } finally {
      setEditorSaveBusy(false);
    }
  }

  async function createEntryIdempotently(body) {
    try {
      return await api("/entries", { method: "POST", body });
    } catch (error) {
      if (!error?.transportOutcomeUnknown) throw error;
      return api("/entries", { method: "POST", body });
    }
  }

  async function finalizeCommittedPhotoEntry(entryId, finalBody, provisionalEntry) {
    try {
      return await api(`/entries/${entryId}`, {
        method: "PUT",
        body: { ...finalBody, revision: provisionalEntry.revision }
      });
    } catch (error) {
      if (!error?.transportOutcomeUnknown && error?.status !== 409) throw error;
      return reconcileCommittedPhotoEntry(entryId, finalBody, provisionalEntry);
    }
  }

  async function reconcileCommittedPhotoEntry(entryId, finalBody, provisionalEntry) {
    const current = (await api(`/entries/${entryId}`)).entry;
    if (entryMatchesEditorPayload(current, finalBody)) return { entry: current };
    if (!entryMatchesEditorPayload(current, provisionalEntry)) {
      throw new Error("別の端末で更新された可能性があります。再読み込みしてください。");
    }

    try {
      return await api(`/entries/${entryId}`, {
        method: "PUT",
        body: { ...finalBody, revision: current.revision }
      });
    } catch (error) {
      if (!error?.transportOutcomeUnknown && error?.status !== 409) throw error;
      const confirmed = (await api(`/entries/${entryId}`)).entry;
      if (entryMatchesEditorPayload(confirmed, finalBody)) return { entry: confirmed };
      if (!entryMatchesEditorPayload(confirmed, current)) {
        throw new Error("別の端末で更新された可能性があります。再読み込みしてください。");
      }
      throw new Error("通信結果を確認できませんでした。通信が安定してから、もう一度保存してください。");
    }
  }

  function entryMatchesEditorPayload(entry, payload) {
    if (!entry || !payload) return false;
    return String(entry.entryDate || "") === String(payload.entryDate || "")
      && String(entry.title || "") === String(payload.title || "")
      && String(entry.content || "") === String(payload.content || "")
      && canonicalJson(entry.contentFormat || null) === canonicalJson(payload.contentFormat || null)
      && orderedStringList(entry.tags) === orderedStringList(payload.tags)
      && String(entry.status || "published") === String(payload.status || "published")
      && canonicalStringList(entry.excludedPhotoIds) === canonicalStringList(payload.excludedPhotoIds);
  }

  function canonicalStringList(values) {
    return JSON.stringify((Array.isArray(values) ? values : []).map(String).sort((left, right) => left.localeCompare(right, "en")));
  }

  function orderedStringList(values) {
    return JSON.stringify((Array.isArray(values) ? values : []).map(String));
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function setEditorSaveBusy(busy, label = "") {
    elements.saveEntryButton.disabled = busy;
    elements.saveDraftButton.disabled = busy;
    elements.cancelEntryButton.disabled = busy;
    elements.editorLeaveSaveDraft.disabled = busy;
    if (busy) {
      if (label) elements.editorMessage.textContent = label;
    }
    elements.saveEntryButton.textContent = "投稿";
    elements.saveDraftButton.textContent = "下書き保存";
  }

  async function openCameraRoll() {
    elements.cameraRollDialog.showModal();
    pushCameraRollHistory();
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
    elements.photoMonthFilter.replaceChildren(createOption("", "すべて"), ...(result.months || []).map((item) => (
      createOption(item.value, `${formatMonth(item.value)}（${item.count}）`)
    )));
    elements.photoMonthFilter.value = monthValue;
  }

  function shouldShowEntryAuthor() {
    return state.activeHouseholdId !== "chiharu-household";
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
    if (state.photoEntryQuery) parameters.set("entryQuery", state.photoEntryQuery);
    if (state.photoMonth) parameters.set("month", state.photoMonth);
    if (state.photoFileNameQuery) parameters.set("fileName", state.photoFileNameQuery);
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
        button.setAttribute("aria-label", `${formatDate(photo.entryDate)}「${photo.entryTitle || "無題"}」の写真を開く`);
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
    const index = Number(button.dataset.photoIndex);
    if (!state.photos[index]) return;
    openPhotoViewer(state.photos, index);
  }

  function openPhotoViewer(photos, index) {
    if (!photos?.length || index < 0 || index >= photos.length) return;
    state.viewerPhotos = photos;
    state.viewerIndex = index;
    renderPhotoViewer();
    elements.photoViewerDialog.showModal();
    pushPhotoViewerHistory();
  }

  function closeCameraRollDialog(afterClose = null) {
    if (typeof afterClose === "function") state.cameraRollAfterClose = afterClose;
    if (state.cameraRollClosePending) return;
    if (!elements.cameraRollDialog.open) {
      finishCameraRollClose();
      return;
    }
    if (
      state.cameraRollHistoryToken
      && window.history.state?.[CAMERA_ROLL_HISTORY_KEY] === state.cameraRollHistoryToken
    ) {
      state.cameraRollClosePending = true;
      window.history.back();
      return;
    }
    finishCameraRollClose();
  }

  function finishCameraRollClose() {
    const afterClose = state.cameraRollAfterClose;
    state.cameraRollAfterClose = null;
    state.cameraRollHistoryToken = null;
    state.cameraRollClosePending = false;
    if (elements.cameraRollDialog.open) elements.cameraRollDialog.close();
    if (afterClose) afterClose();
  }

  function closePhotoViewerDialog(afterClose = null) {
    if (typeof afterClose === "function") state.photoViewerAfterClose = afterClose;
    if (state.photoViewerClosePending) return;
    if (!elements.photoViewerDialog.open) {
      finishPhotoViewerClose();
      return;
    }
    if (
      state.photoViewerHistoryToken
      && window.history.state?.[PHOTO_VIEWER_HISTORY_KEY] === state.photoViewerHistoryToken
    ) {
      state.photoViewerClosePending = true;
      window.history.back();
      return;
    }
    finishPhotoViewerClose();
  }

  function finishPhotoViewerClose() {
    const afterClose = state.photoViewerAfterClose;
    state.photoViewerAfterClose = null;
    state.photoViewerHistoryToken = null;
    state.photoViewerClosePending = false;
    if (elements.photoViewerDialog.open) elements.photoViewerDialog.close();
    if (afterClose) afterClose();
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
    closePhotoViewerDialog(() => {
      if (elements.cameraRollDialog.open) {
        closeCameraRollDialog(() => openEntry(photo.entryId));
        return;
      }
      if (!elements.entryDialog.open || state.activeEntry?.id !== photo.entryId) openEntry(photo.entryId);
    });
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
    input.addEventListener("click", handleDateClick);
    input.addEventListener("keydown", handleDateKeydown);
    input.addEventListener("beforeinput", preventDateDirectInput);
    input.addEventListener("paste", preventDateDirectInput);
    input.addEventListener("drop", preventDateDirectInput);
    input.addEventListener("selectstart", preventDateDirectInput);
  }

  function preventDateDirectInput(event) {
    event.preventDefault();
  }

  function handleDateClick(event) {
    event.preventDefault();
    event.currentTarget.blur();
    openDateWheel(event.currentTarget);
  }

  function handleDateKeydown(event) {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (["Enter", " "].includes(event.key)) {
      event.currentTarget.blur();
      openDateWheel(event.currentTarget);
    }
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

  function applyDateWheelFromBackdrop(event) {
    if (event.target === elements.dateWheelDialog) applyDateWheel();
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
    const scrollToken = String((Number(column.dataset.settingScrollToken) || 0) + 1);
    column.dataset.settingScroll = "true";
    column.dataset.settingScrollToken = scrollToken;
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
      if (column.dataset.settingScrollToken !== scrollToken) return;
      column.scrollTop = selectedIndex * 44;
      window.setTimeout(() => {
        if (column.dataset.settingScrollToken !== scrollToken) return;
        delete column.dataset.settingScroll;
        delete column.dataset.settingScrollToken;
      }, 160);
    });
  }

  function bindDateWheel(column, key) {
    column.addEventListener("click", (event) => {
      const option = event.target.closest(".date-wheel-option");
      if (!option) return;
      const value = Number(option.dataset.value);
      if (state.dateDraft) {
        state.dateDraft[key] = value;
        if (key === "year" || key === "month") renderDayWheel();
        updateDateWheelValue();
      }
      column.querySelectorAll(".date-wheel-option").forEach((item) => {
        item.setAttribute("aria-selected", String(item === option));
      });
      column.scrollTo({ top: Number(option.dataset.index) * 44, behavior: "smooth" });
    });
    column.addEventListener("wheel", (event) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const options = column.querySelectorAll(".date-wheel-option");
      if (!options.length) return;
      const visibleIndex = clamp(Math.round(column.scrollTop / 44), 0, options.length - 1);
      const direction = event.deltaY > 0 ? 1 : -1;
      column.scrollTop = clamp(visibleIndex + direction, 0, options.length - 1) * 44;
    }, { passive: false });
    column.addEventListener("scroll", () => {
      if (column.dataset.settingScroll === "true") return;
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
    state.drafts = false;
    state.favoritePage = false;
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

  function toggleDrafts() {
    if (!state.canManageEntries) return;
    state.drafts = !state.drafts;
    state.trash = false;
    state.favoritePage = false;
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
    state.drafts = false;
    state.favoritePage = false;
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
    const active = Boolean(state.query || state.dateFrom || state.dateTo || state.tag || state.trash || state.drafts || state.favoritePage);
    elements.searchClear.hidden = !state.query;
    elements.dateReset.hidden = !state.dateFrom && !state.dateTo;
    elements.clearFilters.hidden = !active;
    elements.trashButton.setAttribute("aria-pressed", String(state.trash));
    elements.trashButton.setAttribute("aria-label", state.trash ? "日記一覧へ戻る" : "ゴミ箱");
    elements.trashButton.title = state.trash ? "日記一覧へ戻る" : "ゴミ箱";
    elements.draftButton.setAttribute("aria-pressed", String(state.drafts));
    elements.draftButton.setAttribute("aria-label", state.drafts ? "日記一覧へ戻る" : `下書き（${state.draftCount}件）`);
    elements.draftButton.title = state.drafts ? "日記一覧へ戻る" : `下書き（${state.draftCount}件）`;
    elements.searchPanel.hidden = state.drafts || state.favoritePage || state.tagDirectory || Boolean(state.tag);
    elements.monthNavigation.hidden = !isMonthlyView();
    elements.currentMonth.disabled = state.month === currentJapanMonth();
    document.querySelectorAll("[data-month]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.month === state.month));
    });
    document.querySelectorAll("[data-tag]").forEach((button) => {
      if (button.dataset.tag === state.tag) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (state.favoritePage) elements.favoritesLink?.setAttribute("aria-current", "page");
    else elements.favoritesLink?.removeAttribute("aria-current");
  }

  function updateListHeading() {
    if (state.favoritePage) {
      elements.listKicker.textContent = "Favorites";
      elements.listTitle.textContent = "お気に入りの日記";
    } else if (state.drafts) {
      elements.listKicker.textContent = "Draft";
      elements.listTitle.textContent = "下書き";
    } else if (state.trash) {
      elements.listKicker.textContent = "Trash";
      elements.listTitle.textContent = "ゴミ箱";
    } else if (state.tag) {
      elements.listKicker.textContent = "Hashtag";
      elements.listTitle.textContent = `#${state.tag}の日記一覧`;
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
    if (state.favoritePage) {
      elements.searchStatus.textContent = `${state.entries.length}件のお気に入りの日記を表示しています。`;
    } else if (state.drafts) {
      elements.searchStatus.textContent = `${state.entries.length}件の下書きを表示しています。`;
    } else if (state.trash) {
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
    state.drafts = false;
    state.favoritePage = false;
    updateFilterControls();
    loadEntries(true);
  }

  function isMonthlyView() {
    return !state.trash && !state.drafts && !state.favoritePage && !state.query && !state.dateFrom && !state.dateTo && !state.tag;
  }

  function changeBrowseMonth(offset) {
    if (!isMonthlyView()) return;
    const nextMonth = shiftMonth(state.month, offset);
    state.month = nextMonth;
    state.monthExpanded = false;
    updateFilterControls();
    loadEntries(true);
  }

  function returnToCurrentMonth() {
    if (!isMonthlyView() || state.month === currentJapanMonth()) return;
    state.month = currentJapanMonth();
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
    if (id === "editor-dialog") {
      requestEditorClose();
      return;
    }
    if (id === "camera-roll-dialog") {
      closeCameraRollDialog();
      return;
    }
    if (id === "photo-viewer-dialog") {
      closePhotoViewerDialog();
      return;
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

    let response;
    try {
      response = await fetch(`${BASE_PATH}/api${path}`, init);
    } catch (cause) {
      const error = new Error("通信結果を確認できませんでした。通信状態を確認して、もう一度お試しください。");
      error.transportOutcomeUnknown = true;
      error.cause = cause;
      throw error;
    }
    let result;
    try {
      result = await response.json();
    } catch (cause) {
      if (!response.ok) result = {};
      else {
        const error = new Error("通信結果を確認できませんでした。通信状態を確認して、もう一度お試しください。");
        error.transportOutcomeUnknown = true;
        error.cause = cause;
        throw error;
      }
    }
    if (!response.ok) {
      if (response.status === 401 && path !== "/login" && path !== "/passkey/handoff") {
        resetState();
        showLogin("ログインの有効期限が切れました。");
      }
      const error = new Error(result.error || "処理を完了できませんでした。");
      error.status = response.status;
      throw error;
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
    const onTagDirectory = /^\/diary\/tags\/?$/.test(window.location.pathname);
    const onFavoritePage = /^\/diary\/favorites\/?$/.test(window.location.pathname);
    let tag = "";
    if (match) {
      try {
        tag = decodeURIComponent(match[1]).normalize("NFKC").trim().slice(0, 100);
      } catch {
        tag = "";
      }
    }
    state.tag = tag;
    state.tagDirectory = onTagDirectory;
    state.favoritePage = onFavoritePage;
    const onTagPage = Boolean(tag);
    elements.tagPageBack.hidden = !onTagPage && !onTagDirectory && !onFavoritePage;
    elements.tagPageBack.textContent = "← 日記へ戻る";
    elements.searchPanel.hidden = onTagPage;
    elements.diaryMain.hidden = onTagDirectory;
    elements.archivePanel.hidden = onTagDirectory;
    elements.tagDirectoryLink.hidden = onTagDirectory;
    elements.diaryLayout.classList.toggle("is-tag-directory", onTagDirectory);
    elements.tagPanel.classList.toggle("is-directory", onTagDirectory);
    elements.diaryKicker.textContent = onTagPage || onTagDirectory ? "Hashtag" : "Diary";
    elements.diaryTitle.textContent = onTagPage ? `#${tag}の日記一覧` : (onTagDirectory ? "タグ一覧" : "日記");
    document.title = onTagPage ? `#${tag}の日記一覧 | 日記` : (onTagDirectory ? "タグ一覧 | 日記" : "日記");
    if (onFavoritePage) {
      elements.searchPanel.hidden = true;
      elements.diaryKicker.textContent = "Favorites";
      elements.diaryTitle.textContent = "お気に入り";
      document.title = "お気に入り";
    }
    if (onFavoritePage) elements.favoritesLink?.setAttribute("aria-current", "page");
    else elements.favoritesLink?.removeAttribute("aria-current");
    configureDiaryReturnNavigation();
  }

  function configureDiaryReturnNavigation() {
    if (elements.tagPageBack.hidden) return;
    let returnView = null;
    try {
      returnView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
    } catch {
      return;
    }
    if (returnView?.version !== 2 || returnView.destinationPath !== window.location.pathname) return;
    if (!isDiaryListPath(returnView.routePath) || Date.now() - returnView.savedAt > RETURN_VIEW_MAX_AGE_MS) return;
    elements.tagPageBack.href = returnView.routePath;
    elements.tagPageBack.textContent = "← 前の画面へ戻る";
  }

  function isDiaryListPath(pathname) {
    return /^\/diary\/?$/.test(pathname)
      || /^\/diary\/(?:tags|favorites)\/?$/.test(pathname)
      || /^\/diary\/tag\/[^/]+\/?$/.test(pathname);
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

  function formatDateTime(value) {
    const date = new Date(String(value || "").replace(" ", "T") + (String(value || "").includes("Z") ? "" : "Z"));
    if (Number.isNaN(date.getTime())) return value || "不明";
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
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

  function setBusyIconButton(button, busy, processingLabel, idleLabel) {
    button.disabled = busy;
    button.setAttribute("aria-disabled", String(busy));
    if (busy) {
      button.setAttribute("aria-label", processingLabel);
      button.title = processingLabel;
      return;
    }
    if (idleLabel !== undefined) {
      button.setAttribute("aria-label", idleLabel);
      button.title = idleLabel;
    }
    button.removeAttribute("aria-disabled");
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
    resetHeaderVisibilityTracking();
    state.role = null;
    state.accountName = null;
    state.householdId = null;
    state.activeHouseholdId = null;
    state.isGlobalOwner = false;
    state.mustChangePassword = false;
    state.pendingLoginId = "";
    state.canManageEntries = false;
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
    state.favoritePage = false;
    state.availableTags = [];
    state.trash = false;
    state.drafts = false;
    state.draftCount = 0;
    state.activeEntry = null;
    state.deleteMode = null;
    clearEditorPhotos();
    state.photoOffset = 0;
    state.photos = [];
    state.photoHasMore = false;
    state.photoEntryQuery = "";
    state.photoMonth = "";
    state.photoFileNameQuery = "";
    state.viewerPhotos = [];
    state.viewerIndex = -1;
    state.cameraRollHistoryToken = null;
    state.cameraRollAfterClose = null;
    state.cameraRollClosePending = false;
    state.photoViewerHistoryToken = null;
    state.photoViewerAfterClose = null;
    state.photoViewerClosePending = false;
    finishPhotoPickerInteraction();
    state.editorDirty = false;
    state.editorSourceEntry = null;
    state.entryCreateRequestId = null;
    state.dateDraft = null;
    state.dateWheelTarget = null;
    state.entryAfterClose = null;
    state.entryHistoryToken = null;
    state.entryClosePending = false;
    state.favoriteRequestPending = false;
    state.editorHistoryToken = null;
    state.editorClosePending = false;
    elements.searchInput.value = "";
    elements.dateFrom.value = "";
    elements.dateTo.value = "";
    elements.tagSearchInput.value = "";
    if (elements.dateWheelDialog.open) elements.dateWheelDialog.close();
    state.requestId += 1;
    if (elements.entryDialog.open) elements.entryDialog.close();
    if (elements.editorDialog.open) elements.editorDialog.close();
    if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
    closeEntryFormatToolbar();
    if (elements.cameraRollDialog.open) elements.cameraRollDialog.close();
    if (elements.photoViewerDialog.open) elements.photoViewerDialog.close();
  }
})();

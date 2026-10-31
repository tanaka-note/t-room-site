export async function startDiary(initialSession, deferredInstallPrompt = null, onReady = () => deferredInstallPrompt, initialScrollIntent = {}) {
  // Keep the shared module on the same build URL as this app shell, including offline fallback.
  const scriptUrl = new URL(import.meta.url);
  let splitSearchTerms, createSearchExcerpt, highlightSearchTerms;
  let applyFormatToSelection, findPhotoMarkers, getSelectionFormatState, hasTextMarks,
    insertTextIntoRichDocument, mergeRichTextRuns, photoMarker, removeTextFromRichDocument,
    replaceTextInRichDocument, sameTextMarks, tokenizeEditorDocument, tokenizeEntryTextWithLinks, withoutPhotoMarkers;
  let WEATHER_LABELS, createWeatherIcon, createUnsetWeatherIcon;
  let photoViewer, photoViewerPromise;
  let viewerOpenRequest = 0;
  const readingToolsReady = Promise.all([
    import(new URL(`diary-search.js${scriptUrl.search}`, scriptUrl).href),
    import(new URL(`diary-rich-text.js${scriptUrl.search}`, scriptUrl).href),
    import(new URL(`diary-weather.js${scriptUrl.search}`, scriptUrl).href)
  ]).then(([search, richText, weather]) => {
    ({ splitSearchTerms, createSearchExcerpt, highlightSearchTerms } = search);
    ({ applyFormatToSelection, findPhotoMarkers, getSelectionFormatState, hasTextMarks,
      insertTextIntoRichDocument, mergeRichTextRuns, photoMarker, removeTextFromRichDocument,
      replaceTextInRichDocument, sameTextMarks, tokenizeEditorDocument, tokenizeEntryTextWithLinks, withoutPhotoMarkers } = richText);
    ({ WEATHER_LABELS, createWeatherIcon, createUnsetWeatherIcon } = weather);
  });
  const BASE_PATH = "/diary";
  let sessionGeneration = 0;
  let loginAttempt = 0;
  let activeSessionContext = "";
  let editorSaveTiming = null;
  const RETURN_VIEW_STORAGE_KEY = "troom-diary-return-view-v1";
  const RETURN_VIEW_HISTORY_KEY = "troomDiaryReturnView";
  const RETURN_NAVIGATION_KEY = "troomDiaryReturnNavigation";
  const RETURN_NAVIGATION_MAX_AGE_MS = 30 * 1000;
  const RETURN_VIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const MONTH_HEADING_SCROLL_GAP_PX = 12;
  const TAG_SUGGESTION_MAX_HEIGHT = 246;
  const CAMERA_ROLL_MAX_PHOTOS = 4800;
  const CAMERA_ROLL_PAGE_SIZE = 96;
  const CAMERA_ROLL_LOAD_BUDGET_MS = 8000;
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
    editorWeather: null,
    editorSourceEntry: null,
    editorSelection: null,
    editorSelectionOffsets: null,
    editorComposing: false,
    editorToolbarOpen: false,
    dateDraft: null,
    dateWheelTarget: null,
    dateWheelTimers: {},
    searchTimer: null,
    searchComposing: false,
    entriesAbortController: null,
    requestId: 0,
    deleteMode: null,
    editorPhotos: [],
    editorDeletedPhotoIds: new Set(),
    editorPendingPhotoDeletionIds: new Set(),
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
    photoOrder: "newest",
    photoFileNameQuery: "",
    photoRequestId: 0,
    photoLoading: false,
    photoSearchTimer: null,
    viewerPhotos: [],
    viewerIndex: -1,
    photoPickerActive: false,
    favoriteRequestPending: false,
    entryCreateRequestId: null,
    deferredInstallPrompt: null,
    lastSessionRefreshAt: 0,
    lastHeaderScrollY: 0,
    headerScrollOffset: 0,
    headerScrollFrame: 0
  };

  const dialogs = TroomDialogNavigation.create({ key: "troomDiaryDialogs" });
  let photoPickerReturnHandler = null;
  const elements = {
    bootView: document.querySelector("#boot-view"),
    loginView: document.querySelector("#login-view"),
    appView: document.querySelector("#app-view"),
    siteHeader: document.querySelector("#site-header"),
    loginMessage: document.querySelector("#login-message"),
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
    tagTotalCount: document.querySelector("#tag-total-count"),
    tagSearchInput: document.querySelector("#tag-search-input"),
    tagDirectoryLink: document.querySelector("#tag-directory-link"),
    tagMore: document.querySelector("#tag-more-button"),
    entryDialog: document.querySelector("#entry-dialog"),
    detailDate: document.querySelector("#detail-date"),
    detailPublishedAt: document.querySelector("#detail-published-at"),
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
    deleteDraftButton: document.querySelector("#delete-draft-button"),
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
    weatherButton: document.querySelector("#entry-weather-button"),
    weatherMenu: document.querySelector("#entry-weather-menu"),
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
    photoSortButton: document.querySelector("#photo-sort-button"),
    photoFileNameSearch: document.querySelector("#photo-file-name-search"),
    cameraRollStatus: document.querySelector("#camera-roll-status"),
    cameraRollGrid: document.querySelector("#camera-roll-grid"),
    cameraRollMore: document.querySelector("#camera-roll-more"),
    photoViewerDialog: document.querySelector("#photo-viewer-dialog"),
    photoStage: document.querySelector("#photo-viewer-dialog .photo-stage"),
    photoViewerDate: document.querySelector("#photo-viewer-date"),
    photoViewerTitle: document.querySelector("#photo-viewer-title"),
    photoViewerImage: document.querySelector("#photo-viewer-image"),
    photoViewerStatus: document.querySelector("#photo-viewer-status"),
    photoViewerFile: document.querySelector("#photo-viewer-file"),
    photoOpenEntry: document.querySelector("#photo-open-entry"),
    photoDownloadLow: document.querySelector("#photo-download-low"),
    photoDownloadOriginal: document.querySelector("#photo-download-original"),
    toast: document.querySelector("#toast")
  };

  let photoToolsPromise;
  let photoUploadManager;
  async function loadPhotoTools() {
    if (!photoToolsPromise) {
      photoToolsPromise = Promise.all([
        import(new URL(`diary-photo-processing.js${scriptUrl.search}`, scriptUrl).href),
        import(new URL(`diary-photo-upload.js${scriptUrl.search}`, scriptUrl).href)
      ]).then(([processing, upload]) => {
        photoUploadManager = upload.createPhotoUploadManager({ state, api, basePath: BASE_PATH, onSessionExpired:()=>{resetState();showLogin("ログインの有効期限が切れました。");},
          getTargetEntryId: () => Number(elements.entryId.value || 0) || null });
        return processing;
      }).catch(error => { photoToolsPromise = null; throw error; });
    }
    return photoToolsPromise;
  }
  function cancelEditorPhotoUploadSession() { return photoUploadManager?.cancelEditorPhotoUploadSession(); }
  function commitStagedPhotos(...args) { return photoUploadManager.commitStagedPhotos(...args); }
  function deleteStagedPhotoUpload(...args) { return photoUploadManager?.deleteStagedPhotoUpload(...args); }
  function ensurePhotosUploaded(photos) { return photos.length ? photoUploadManager.ensurePhotosUploaded(photos) : Promise.resolve(); }
  function queueBackgroundPhotoUpload(...args) { return photoUploadManager.queueBackgroundPhotoUpload(...args); }
  function releaseUploadedPhotoPayload(...args) { return photoUploadManager.releaseUploadedPhotoPayload(...args); }

  // Only input expresses user intent. Scroll events also come from restoration,
  // browser anchoring and dialogs, so they must never cancel a restoration.
  let positionVersion = 0;
  const positionFrames = new Map();
  function cancelPositionRestoration() {
    positionVersion += 1;
    for (const [frame, resolve] of positionFrames) {
      window.cancelAnimationFrame(frame);
      resolve(false);
    }
    positionFrames.clear();
  }
  function schedulePositionRestoration(restore, version = positionVersion) {
    if (version !== positionVersion) return Promise.resolve(false);
    return new Promise(resolve => {
      const frame = window.requestAnimationFrame(() => {
        positionFrames.delete(frame);
        if (version !== positionVersion || elements.appView.hidden) { resolve(false); return; }
        restore();
        resolve(true);
      });
      positionFrames.set(frame, resolve);
    });
  }
  for (const type of ["wheel", "touchmove", "pointerdown"]) {
    window.addEventListener(type, cancelPositionRestoration, { passive: true, capture: true });
  }
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelPositionRestoration();
  });

  await boot();

  async function boot() {
    applyRouteState();
    // Fetch data alongside rendering tools; display the authorized shell immediately.
    elements.appView.inert = true;
    const startup = enterDiary(initialSession);
    loadPhotoViewer().catch(() => {});
    await readingToolsReady;
    bindEvents();
    state.deferredInstallPrompt = onReady();
    updateInstallButtonVisibility();
    elements.appView.inert = false;
    await startup;
  }

  function loadPhotoViewer() {
    if (!photoViewerPromise) {
      photoViewerPromise = import(new URL(`diary-photo-viewer.js${scriptUrl.search}`, scriptUrl).href).then(viewer => {
        photoViewer = viewer.createPhotoViewer({
          nodes: {
            dialog: elements.photoViewerDialog, stage: elements.photoStage,
            shell: elements.photoViewerDialog.querySelector('.photo-viewer-shell'),
            zoomReset: document.querySelector('#photo-zoom-reset'),
            fullscreen: document.querySelector('#photo-fullscreen'),
            date: elements.photoViewerDate, title: elements.photoViewerTitle,
            get image() { return elements.photoViewerImage; },
            set image(value) { elements.photoViewerImage = value; },
            status: elements.photoViewerStatus, file: elements.photoViewerFile,
            downloadLow: elements.photoDownloadLow, downloadOriginal: elements.photoDownloadOriginal
          },
          selection: {
            get photos() { return state.viewerPhotos; },
            get index() { return state.viewerIndex; },
            set index(value) { state.viewerIndex = value; }
          },
          formatDate, formatBytes
        });
        photoViewer.bind();
        return photoViewer;
      }).catch(error => { photoViewerPromise = null; throw error; });
    }
    return photoViewerPromise;
  }

  function bindEvents() {
    document.addEventListener("troom:before-auto-update", (event) => {
      if (hasEditorChanges() || state.editorComposing || state.photoPreparing || state.photoUploading || state.photoPickerActive || document.querySelector("dialog[open]")) {
        event.preventDefault();
      }
    });
    window.addEventListener("scroll", scheduleHeaderVisibilityUpdate, { passive: true });
    document.addEventListener("click", rememberDiaryReturnViewFromNavigation, true);
    window.addEventListener("pageshow", restoreDiaryReturnViewFromPageCache);
    window.addEventListener("pagehide", () => {
      if (isDiaryListRoute() && !elements.appView.hidden && !state.entriesAbortController) {
        storeDiaryReturnView("", { historyOnly: true });
      }
      cancelPositionRestoration();
      if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    });
    document.querySelector("#passkey-login")?.addEventListener("click", handlePasskeyLogin);
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
      cancelPendingEntrySearch();
      elements.searchInput.value = "";
      state.query = "";
      state.favoritePage = false;
      state.monthExpanded = false;
      updateFilterControls();
      loadEntries(true);
      elements.searchInput.focus();
    });
    document.querySelectorAll("[data-clear-search]").forEach((button) => {
      const input = document.getElementById(button.dataset.clearSearch);
      button.addEventListener("click", () => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus({ preventScroll: true });
      });
    });
    elements.searchInput.addEventListener("compositionstart", () => {
      state.searchComposing = true;
      cancelPendingEntrySearch();
    });
    elements.searchInput.addEventListener("compositionend", () => {
      state.searchComposing = false;
      scheduleEntrySearch();
    });
    elements.searchInput.addEventListener("input", (event) => {
      if (state.searchComposing || event.isComposing) return;
      scheduleEntrySearch();
    });
    elements.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || state.searchComposing || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      scheduleEntrySearch(0);
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

    elements.favoriteEntryButton.addEventListener("click", toggleFavorite);
    elements.deleteEntryButton.addEventListener("click", requestEntryDeletion);
    elements.deleteDraftButton.addEventListener("click", requestDraftDeletion);
    elements.restoreEntryButton.addEventListener("click", restoreActiveEntry);
    elements.permanentlyDeleteEntryButton.addEventListener("click", requestPermanentDeletion);
    elements.deleteConfirmNo.addEventListener("click", closeDeleteConfirmation);
    elements.deleteConfirmYes.addEventListener("click", confirmEntryDeletion);

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

    bindDateWheel(elements.dateWheelYear, "year");
    bindDateWheel(elements.dateWheelMonth, "month");
    bindDateWheel(elements.dateWheelDay, "day");
    elements.entryForm.addEventListener("input", () => {
      state.editorDirty = true;
    });
    setupWeatherPicker();
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
      if (!state.photoMonth) state.photoOrder = "newest";
      updatePhotoSortButton();
      loadPhotos(true);
    });
    elements.photoSortButton.addEventListener("click", () => {
      if (!state.photoMonth) return;
      state.photoOrder = state.photoOrder === "newest" ? "oldest" : "newest";
      updatePhotoSortButton();
      loadPhotos(true);
    });
    elements.photoEntrySearch.addEventListener("input", () => {
      cancelCameraRollLoad();
      elements.cameraRollMore.disabled = true;
      state.photoEntryQuery = elements.photoEntrySearch.value.trim();
      state.photoSearchTimer = window.setTimeout(() => loadPhotos(true), 300);
    });
    elements.photoFileNameSearch.addEventListener("input", () => {
      cancelCameraRollLoad();
      elements.cameraRollMore.disabled = true;
      state.photoFileNameQuery = elements.photoFileNameSearch.value.trim();
      state.photoSearchTimer = window.setTimeout(() => loadPhotos(true), 300);
    });
    elements.photoOpenEntry.addEventListener("click", openViewerEntry);

    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
    });

    elements.editorLeaveCancel.addEventListener("click", cancelEditorLeave);
    elements.editorLeaveDiscard.addEventListener("click", discardEditorChanges);
    elements.editorLeaveSaveDraft.addEventListener("click", () => saveEntryAsDraft({ closeAfter: true }));

    window.addEventListener("beforeunload", (event) => {
      if (!hasEditorChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    registerDialogs();
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

  async function handlePasskeyLogin() {
    const attempt = ++loginAttempt;
    const button = document.querySelector("#passkey-login");
    setBusy(button, true, "確認中…");
    elements.loginMessage.textContent = "";
    try {
      const authentication = await TRoomPasskeys.authenticate("diary", choosePasskeyLink);
      if (attempt !== loginAttempt) return;
      const session = await api("/passkey/handoff", { method: "POST", body: { handoffToken: authentication.handoff.handoffToken } });
      if (attempt !== loginAttempt) return;
      await enterDiary(session);
    } catch (error) {
      if (attempt !== loginAttempt) return;
      elements.loginMessage.textContent = /ID・パスワード/.test(error.message)
        ? "パスキーを利用できるブラウザで開いてください。復旧が必要な場合は管理者へご相談ください。"
        : error.message;
    } finally {
      if (attempt === loginAttempt) setBusy(button, false, "パスキーでログイン");
    }
  }

  async function choosePasskeyLink(links) {
    return TRoomPasskeys.chooseLinkDialog(links, "diary");
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

  async function enterDiary(session) {
    cancelPositionRestoration();
    const restoreVersion = initialScrollIntent.interrupted ? -1 : positionVersion;
    const generation = ++sessionGeneration;
    activeSessionContext = sessionContext(session);
    state.role = session.role;
    state.accountName = session.accountName;
    state.householdId = session.householdId;
    state.activeHouseholdId = session.activeHouseholdId || session.householdId;
    updateDiaryReturnNavigation();
    state.isGlobalOwner = Boolean(session.isGlobalOwner);
    state.canManageEntries = Boolean(session.canManageEntries);
    state.canViewTrash = Boolean(session.canViewTrash);
    state.canPermanentlyDelete = Boolean(session.canPermanentlyDelete);
    state.canViewInvestment = Boolean(session.canViewInvestment);
    const returnView = takeDiaryReturnView(state.activeHouseholdId);
    if (!returnView && "scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    if (returnView) {
      if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
      await readingToolsReady;
      if (generation !== sessionGeneration) return;
      applyDiaryReturnView(returnView);
    }
    state.lastSessionRefreshAt = Date.now();
    elements.roleLabel.textContent = session.accountDisplayName || `${session.accountName}（${session.role === "admin" ? "管理者" : "一般ユーザー"}）`;
    elements.newEntryButton.hidden = !state.canManageEntries;
    elements.draftButton.hidden = !state.canManageEntries;
    elements.trashButton.hidden = !state.canViewTrash;
    elements.investmentSection.hidden = !state.canViewInvestment || state.tagDirectory;
    updateFilterControls();
    // Apply trusted authorization and clear prior data before exposing the shell.
    elements.householdSwitcherWrap.hidden = true;
    elements.householdSwitcher.replaceChildren();
    elements.entryList.replaceChildren(createEmpty("読み込んでいます..."));
    elements.archiveList.replaceChildren();
    elements.tagList.replaceChildren();
    elements.bootView.hidden = true;
    elements.loginView.hidden = true;
    elements.appView.hidden = false;
    resetHeaderVisibilityTracking();
    const initialRequestId = state.requestId + 1;
    const loaded = await loadEntries(true, true, returnView?.entryCount || 0);
    if (generation !== sessionGeneration || initialRequestId !== state.requestId) return;
    if (loaded && returnView) restoreDiaryReturnPosition(returnView, restoreVersion);
  }

  async function loadHouseholdSwitcher() {
    if (!state.isGlobalOwner) return;
    const generation = sessionGeneration;
    const result = await api("/households");
    if (generation === sessionGeneration) applyHouseholds(result);
  }

  function applyHouseholds(result) {
    elements.householdSwitcherWrap.hidden = !state.isGlobalOwner;
    if (!state.isGlobalOwner) return;
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
      sessionGeneration += 1;
      cancelPendingEntrySearch();
      state.activeHouseholdId = householdId;
      updateDiaryReturnNavigation();
      state.availableTags = [];
      elements.archiveList.replaceChildren();
      elements.tagList.replaceChildren();
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
    elements.bootView.hidden = true;
    elements.loginView.hidden = false;
    elements.appView.hidden = true;
    elements.loginMessage.textContent = message;
    window.setTimeout(() => document.querySelector("#passkey-login").focus(), 0);
  }

  function cancelPendingEntrySearch() {
    cancelPositionRestoration();
    window.clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.entriesAbortController?.abort();
    state.requestId += 1;
  }

  function scheduleEntrySearch(delay = 150) {
    cancelPendingEntrySearch();
    state.query = splitSearchTerms(elements.searchInput.value).join(" ");
    state.favoritePage = false;
    state.monthExpanded = false;
    updateFilterControls();
    if (delay === 0) {
      loadEntries(true);
    } else {
      state.searchTimer = window.setTimeout(() => loadEntries(true), delay);
    }
  }

  function sessionContext(session) {
    return JSON.stringify([session.accountName || "", session.loginId || "", session.householdId, session.activeHouseholdId || session.householdId, session.role,
      ...["isGlobalOwner", "canManageEntries", "canViewTrash", "canPermanentlyDelete", "canViewInvestment"].map(key => Boolean(session[key]))]);
  }

  async function loadEntries(reset, bootstrap = false, returnEntryCount = 0) {
    if (!bootstrap) cancelPositionRestoration();
    const generation = sessionGeneration;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.entriesAbortController?.abort();
    const abortController = new AbortController();
    state.entriesAbortController = abortController;
    const requestId = ++state.requestId;
    const monthlyView = isMonthlyView();
    const targetCount = Math.max(0, Math.min(Number(returnEntryCount) || 0, 2000));
    const pageSize = targetCount ? Math.min(50, Math.max(monthlyView ? 5 : 20, targetCount))
      : monthlyView ? (state.monthExpanded ? 50 : 5) : 20;
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
          limit: String(targetCount > loadedEntries.length ? Math.min(pageSize, targetCount - loadedEntries.length) : pageSize),
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

        let result;
        if (bootstrap && pageGuard === 0) {
          // Keep metadata alive when a user starts a search during initial loading.
          const initial = await api(`/bootstrap?${parameters}`);
          await readingToolsReady;
          if (generation !== sessionGeneration) return;
          if (!initial.session?.authenticated || sessionContext(initial.session) !== activeSessionContext) {
            resetState();
            showLogin("ログイン状態が変わりました。もう一度パスキーでログインしてください。");
            return;
          }
          applyHouseholds(initial.households);
          preserveViewport(() => applyMeta(initial.meta));
          result = initial.entries;
        } else {
          result = await api(`/entries?${parameters}`, { signal: abortController.signal });
        }
        if (requestId !== state.requestId || generation !== sessionGeneration) return;
        loadedEntries.push(...result.entries);
        nextOffset += result.entries.length;
        hasMore = result.hasMore;
        pageGuard += 1;
      } while (hasMore && pageGuard < 100 && ((monthlyView && state.monthExpanded) || loadedEntries.length < targetCount));

      await readingToolsReady;
      if (requestId !== state.requestId || generation !== sessionGeneration) return;
      state.entries = loadedEntries;
      state.entryMap.clear();
      for (const entry of state.entries) state.entryMap.set(entry.id, entry);
      state.offset = state.entries.length;
      state.hasMore = hasMore;
      if (bootstrap) preserveViewport(() => renderEntries(reset ? 0 : previousEntryCount));
      else renderEntries(reset ? 0 : previousEntryCount);
      updateSearchStatus();
      return true;
    } catch (error) {
      if (requestId !== state.requestId) return;
      elements.entryList.replaceChildren(createEmpty(error.message));
      elements.searchStatus.textContent = error.message;
    } finally {
      if (state.entriesAbortController === abortController) state.entriesAbortController = null;
      if (requestId === state.requestId) {
        elements.loadMore.hidden = monthlyView ? state.monthExpanded || !state.hasMore : !state.hasMore;
        setBusy(elements.loadMore, false, monthlyView ? "もっと見る" : "さらに表示");
      }
    }
  }

  function preserveViewport(render) {
    // Compensate synchronous layout/anchoring changes using the position at
    // commit time, including any scrolling performed while the request waited.
    const top = window.scrollY;
    render();
    if (window.scrollY !== top) window.scrollTo({ top, left: 0, behavior: "instant" });
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
    const anchor = position.entryId
      ? elements.entryList.querySelector(`[data-entry-id="${position.entryId}"]`)
      : null;
    if (anchor) {
      window.scrollBy({ top: anchor.getBoundingClientRect().top - position.top, left: 0, behavior: "instant" });
    } else {
      window.scrollTo({ top: position.scrollY, left: 0, behavior: "instant" });
    }
    resetHeaderVisibilityTracking();
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
    if ((link === elements.tagPageBack || (link === elements.favoritesLink && state.favoritePage))
      && hasDiaryReturnNavigation(destination.pathname)) {
      event.preventDefault();
      window.history.back();
      return;
    }
    if (destination.pathname === window.location.pathname) return;
    // The page defaults to no-referrer. Only these same-origin diary links
    // need their source path to validate the one-shot return handoff.
    link.referrerPolicy = "same-origin";
    storeDiaryReturnView(destination.pathname);
  }

  function storeDiaryReturnView(destinationPath = "", { historyOnly = false } = {}) {
    const position = captureEntryListPosition();
    const returnView = {
      version: 2,
      savedAt: Date.now(),
      routePath: window.location.pathname,
      destinationPath,
      householdId: state.activeHouseholdId || "",
      accountName: state.accountName || "",
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
    // Lifecycle snapshots belong to this history entry. Only explicit in-app
    // navigation may replace the shared source snapshot and navigation token.
    if (historyOnly) return;
    try {
      window.sessionStorage.setItem(RETURN_VIEW_STORAGE_KEY, JSON.stringify(returnView));
      window.sessionStorage.setItem(RETURN_NAVIGATION_KEY, JSON.stringify({
        savedAt: returnView.savedAt, sourcePath: returnView.routePath, destinationPath
      }));
    } catch {
      // 保存領域が利用できない場合はブラウザ標準の戻る位置復元へ委ねます。
    }
  }

  function isNewDiaryNavigation() {
    const navigationType = window.performance.getEntriesByType("navigation")[0]?.type;
    return navigationType !== "back_forward" && navigationType !== "reload";
  }

  function takeDiaryReturnView(householdId, fromPageCache = false) {
    if (!fromPageCache && isNewDiaryNavigation()) {
      // Reopening the same start URL can retain the previous history.state.
      // Discard only this page's return snapshot; child pages still need the source snapshot.
      try {
        if (window.history.state?.[RETURN_VIEW_HISTORY_KEY]) {
          const historyState = { ...window.history.state };
          delete historyState[RETURN_VIEW_HISTORY_KEY];
          window.history.replaceState(historyState, "", window.location.href);
        }
        const storedView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
        const routePath = storedView?.version === 1 ? `${BASE_PATH}/` : storedView?.routePath;
        if (routePath === window.location.pathname) window.sessionStorage.removeItem(RETURN_VIEW_STORAGE_KEY);
      } catch {
        // A fresh opening must not restore a position even when storage is unavailable.
      }
      return null;
    }
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
    if (!isOwnedDiaryReturnView(returnView) || returnView.householdId !== householdId) return false;
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
    state.query = splitSearchTerms(returnView.query).join(" ");
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
    elements.tagList.scrollTo({
      top: Math.max(0, Number(position.scrollTop) || 0),
      left: Math.max(0, Number(position.scrollLeft) || 0), behavior: "instant"
    });
    const anchor = position.tag
      ? [...elements.tagList.querySelectorAll("[data-tag]")].find(tag => tag.dataset.tag === position.tag)
      : null;
    if (anchor) elements.tagList.scrollBy({
      top: anchor.getBoundingClientRect().top - elements.tagList.getBoundingClientRect().top - (Number(position.top) || 0),
      left: 0, behavior: "instant"
    });
  }

  function restoreDiaryReturnPosition(returnView, version = positionVersion) {
    if (!returnView) return;
    const restore = () => {
      restoreEntryListPosition(returnView.position);
      restoreTagListPosition(returnView.tagListPosition);
    };
    schedulePositionRestoration(restore, version);
    // A late webfont can change card heights. Correct only while the original
    // restoration still owns the position; never overwrite subsequent input.
    if (document.fonts?.status === "loading") {
      document.fonts.ready.then(() => schedulePositionRestoration(restore, version));
    }
  }

  function restoreDiaryReturnViewFromPageCache(event) {
    if (!event.persisted) return;
    cancelPositionRestoration();
    // BFCache retains the complete DOM, filters and scroll position. Let the
    // browser restore that live page instead of replaying an older snapshot.
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    resetHeaderVisibilityTracking();
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
      && isOwnedDiaryReturnView(returnView)
      && window.history.state?.[RETURN_NAVIGATION_KEY] === returnView.savedAt
      && Date.now() - returnView.savedAt <= RETURN_VIEW_MAX_AGE_MS;
  }

  async function handleLoadMore() {
    if (state.searchTimer !== null) return;
    if (isMonthlyView()) {
      const position = captureEntryListPosition();
      elements.loadMore.blur();
      state.monthExpanded = true;
      const loading = loadEntries(false);
      const version = positionVersion;
      const requestId = state.requestId;
      const generation = sessionGeneration;
      await loading;
      if (generation === sessionGeneration && requestId === state.requestId) {
        schedulePositionRestoration(() => restoreEntryListPosition(position), version);
      }
      return;
    }
    await loadEntries(false);
  }

  async function loadMeta() {
    const generation = sessionGeneration;
    try {
      const result = await api("/meta");
      if (generation === sessionGeneration) applyMeta(result);
    } catch (error) {
      if (generation !== sessionGeneration) return;
      elements.archiveList.replaceChildren(createEmpty(error.message));
      elements.tagList.replaceChildren(createEmpty(error.message));
    }
  }

  function applyMeta(result) {
    state.draftCount = Number(result.draftCount || 0);
    elements.draftCount.textContent = String(state.draftCount);
    elements.draftCount.hidden = state.draftCount < 1;
    elements.draftCount.setAttribute("aria-label", `下書き${state.draftCount}件`);
    updateFilterControls();
    renderArchive(result.months || []);
    renderTags(result.tags || []);
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
    const searchTerms = state.drafts ? [] : splitSearchTerms(state.query);
    const cards = entriesToRender.map((entry) => {
      const article = document.createElement("article");
      article.className = "diary-entry-card";
      article.classList.toggle("is-draft", state.drafts);

      const button = document.createElement("button");
      button.className = "diary-entry-button";
      button.type = "button";
      button.dataset.entryId = String(entry.id);

      const date = document.createElement("time");
      date.className = "entry-date entry-date-primary";
      date.dateTime = entry.entryDate;
      date.textContent = formatDate(entry.entryDate);
      const dateStack = document.createElement("span");
      dateStack.className = "entry-date-stack";
      dateStack.append(date);
      if (entry.lastPublishedAt) {
        const publishedAt = document.createElement("time");
        publishedAt.className = "entry-published-at";
        publishedAt.dateTime = entry.lastPublishedAt;
        publishedAt.textContent = `投稿日時：${formatPublishedDateTime(entry.lastPublishedAt)}`;
        dateStack.append(publishedAt);
      }
      const author = document.createElement("span");
      author.className = "entry-author";
      author.textContent = `投稿者：${entry.authorName}`;
      const meta = document.createElement("div");
      meta.className = "entry-meta";
      meta.append(dateStack);
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
      summary.textContent = (searchTerms.length ? createSearchExcerpt(entry.content, searchTerms) : excerpt(entry.content, 130))
        || (state.drafts ? "本文はまだありません。" : "");
      highlightSearchTerms(title, searchTerms);
      highlightSearchTerms(summary, searchTerms);
      appendTitleWeather(title, entry.weather);
      button.append(meta, title, summary);
      if (state.drafts) {
        const updated = document.createElement("span");
        updated.className = "draft-updated-at";
        updated.textContent = `最終編集：${formatDateTime(entry.updatedAt)}`;
        button.append(updated);
      }
      article.append(button, createTagGroup(entry.tags, searchTerms));
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
    elements.tagTotalCount.textContent = `タグ数 ${state.availableTags.length}`;
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

  async function handleArchiveClick(event) {
    const button = event.target.closest("[data-month]");
    if (!button) return;
    const targetMonth = button.dataset.month;
    const alreadyShowingMonth = isDiaryHomeRoute()
      && isMonthlyView()
      && state.month === targetMonth
      && !elements.loadMore.disabled;
    if (alreadyShowingMonth) {
      await scrollToMonthlyHeadingAfterRender(targetMonth);
      return;
    }
    state.month = targetMonth;
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
    const loading = loadEntries(true);
    const version = positionVersion;
    const requestId = state.requestId;
    const loaded = await loading;
    if (loaded && requestId === state.requestId) await scrollToMonthlyHeadingAfterRender(targetMonth, version);
  }

  function scrollToMonthlyHeadingAfterRender(targetMonth, version = positionVersion) {
    return schedulePositionRestoration(() => {
      if (isDiaryHomeRoute() && isMonthlyView() && state.month === targetMonth && !elements.loadMore.disabled) {
        const headerHeight = elements.siteHeader?.offsetHeight || 0;
        const headingTop = window.scrollY + elements.listTitle.getBoundingClientRect().top;
        window.scrollTo({
          top: Math.max(0, headingTop - headerHeight - MONTH_HEADING_SCROLL_GAP_PX),
          left: 0, behavior: "instant"
        });
        resetHeaderVisibilityTracking();
      }
    }, version);
  }

  async function openEntry(id) {
    try {
      const result = await api(`/entries/${id}`);
      state.activeEntry = result.entry;
      renderEntryDetail(result.entry);
      dialogs.open("entry-dialog");
    } catch (error) {
      showToast(error.message);
    }
  }

  function registerDialogs() {
    TRoomDatePicker.setNavigation(dialogs);
    const canView = () => !elements.appView.hidden;
    dialogs.register("entry-dialog", {
      scrollRoots: () => [elements.detailContent],
      capture: () => state.activeEntry,
      restore: entry => {
        if (!canView() || !entry || !state.entryMap.has(entry.id)) return false;
        state.activeEntry = entry;
        renderEntryDetail(entry);
      },
      onClose: finishEntryClose
    });
    dialogs.register("camera-roll-dialog", { scrollRoots: () => [], restore: canView, onClose: finishCameraRollClose });
    dialogs.register("photo-viewer-dialog", {
      scrollRoots: () => [],
      capture: () => ({ photos: state.viewerPhotos, index: state.viewerIndex }),
      restore: saved => {
        if (!canView() || !photoViewer || !saved.photos[saved.index]) return false;
        state.viewerPhotos = saved.photos;
        state.viewerIndex = saved.index;
        photoViewer.render();
      },
      onClose: finishPhotoViewerClose
    });
    dialogs.register("editor-dialog", {
      blocked: () => state.photoPickerActive,
      guard: () => {
        if (state.editorSaving || state.photoPreparing || state.photoPickerActive) return false;
        closeWeatherMenu(false);
        if (hasEditorChanges()) {
          dialogs.open("editor-leave-dialog");
          return false;
        }
        return true;
      },
      onClose: finishEditorClose
    });
    dialogs.register("editor-leave-dialog", { guard: () => !state.editorSaving });
    dialogs.register("delete-confirm-dialog", { onClose: () => { state.deleteMode = null; } });
    dialogs.register("date-wheel-dialog", { backdrop: applyDateWheel, onClose: () => { state.dateWheelTarget = null; } });
  }

  function requestEditorClose() {
    return dialogs.close("editor-dialog");
  }

  function cancelEditorLeave() {
    return dialogs.close("editor-leave-dialog", { after: () => elements.entryContent.focus({ preventScroll: true }) });
  }

  async function discardEditorChanges() {
    if (state.editorSaving || state.photoPreparing) return;
    if (!await dialogs.close("editor-leave-dialog")) return;
    await cancelEditorPhotoUploadSession();
    state.editorDirty = false;
    await closeEditorDialog();
  }

  async function closeEditorDialog() {
    if (elements.editorLeaveDialog.open) await dialogs.close("editor-leave-dialog", { force: true });
    return dialogs.close("editor-dialog", { force: true });
  }

  function finishEditorClose() {
    closeWeatherMenu(false);
    state.editorWeather = null;
    state.editorDirty = false;
    state.editorSourceEntry = null;
    if (elements.editorLeaveDialog.open) elements.editorLeaveDialog.close();
    if (elements.editorDialog.open) elements.editorDialog.close();
    clearEditorPhotos();
    closeEntryFormatToolbar();
  }

  function closeEntryDialog(afterClose = null) {
    return dialogs.close("entry-dialog", { after: typeof afterClose === "function" ? afterClose : undefined });
  }

  function finishEntryClose() {
    viewerOpenRequest += 1;
    if (elements.entryDialog.open) elements.entryDialog.close();
    state.activeEntry = null;
  }

  function renderEntryDetail(entry) {
    elements.detailDate.textContent = formatDate(entry.entryDate);
    elements.detailPublishedAt.hidden = !entry.lastPublishedAt;
    elements.detailPublishedAt.textContent = entry.lastPublishedAt
      ? `投稿日時：${formatPublishedDateTime(entry.lastPublishedAt)}`
      : "";
    elements.detailTitle.textContent = entry.title;
    elements.detailAuthor.textContent = `投稿者：${entry.authorName}`;
    elements.detailAuthor.hidden = !shouldShowEntryAuthor();
    elements.detailDeletion.hidden = !entry.deletedAt || !entry.deletedByName;
    elements.detailDeletion.textContent = entry.deletedByName ? `削除者：${entry.deletedByName}` : "";
    renderFavoriteButton(entry);
    renderEntryContent(entry);
    const searchTerms = state.drafts ? [] : splitSearchTerms(state.query);
    highlightSearchTerms(elements.detailTitle, searchTerms);
    appendTitleWeather(elements.detailTitle, entry.weather);
    highlightSearchTerms(elements.detailContent, searchTerms);
    elements.detailTags.replaceChildren(...createTagElements(entry.tags, searchTerms));
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
      const processing = await loadPhotoTools();
      const progress = index => { elements.photoPreparationStatus.textContent = `写真を準備中 ${index + 1}/${files.length}`; };
      for await (const result of processing.preparePhotoBatch(files, progress)) {
        if (result.error) {
          failures.push(`${files[result.index].name}：${result.error.message}`);
        } else {
          const photo = result.photo;
          photo.preparationMs = result.preparationMs;
          state.editorPhotos.push(photo);
          preparedPhotos.push(photo);
          preparedCount += 1;
          queueBackgroundPhotoUpload(photo);
        }
      }
      await waitForEditorCompositionEnd();
      if (preparedPhotos.length) {
        insertPhotoMarkersAtOffset(preparedPhotos.map((photo) => photo.id), insertionOffset);
      }
      renderEditorPhotos();
      elements.photoPreparationStatus.textContent = failures.length
        ? `${preparedCount}件を追加しました。追加できなかったファイル（${failures.length}件）：${failures.slice(0, 3).join(" / ")}${failures.length > 3 ? ` / ほか${failures.length - 3}件` : ""}`
        : `${preparedCount}件の写真を本文へ追加しました。`;
    } catch {
      elements.photoPreparationStatus.textContent = "写真の準備を完了できませんでした。もう一度お試しください。";
    } finally {
      elements.photoInput.value = "";
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
    if (inputWouldModifyPhotoMarker(event.inputType)) {
      event.preventDefault();
      elements.editorMessage.textContent = "写真は写真一覧の操作から削除してください。";
      return;
    }
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

  function inputWouldModifyPhotoMarker(inputType = "") {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!elements.entryContent.contains(range.commonAncestorContainer)) return false;
    const offsets = getSerializedEditorRangeOffsets(range);
    if (!offsets) return false;
    const photoMarkers = findPhotoMarkers(getRichEditorPlainText());
    const intersectsSelection = photoMarkers.some((marker) => marker.start < offsets.end && marker.end > offsets.start);
    if (intersectsSelection) return true;
    if (!range.collapsed || !inputType.startsWith("delete")) return false;
    if (inputType.includes("Backward")) {
      return photoMarkers.some((marker) => marker.start < offsets.start && offsets.start <= marker.end);
    }
    if (inputType.includes("Forward")) {
      return photoMarkers.some((marker) => marker.start <= offsets.start && offsets.start < marker.end);
    }
    return false;
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
    const startBoundaryValue = normalizeEditorRangeBoundary(range.startContainer, range.startOffset, "start");
    const endBoundaryValue = normalizeEditorRangeBoundary(range.endContainer, range.endOffset, "end");
    const startPath = getEditorNodePath(startBoundaryValue.container);
    const endPath = getEditorNodePath(endBoundaryValue.container);
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
    endBoundary.setStart(endContainer, endBoundaryValue.offset);
    endBoundary.collapse(true);
    endBoundary.insertNode(endMarker);
    const startBoundary = document.createRange();
    startBoundary.setStart(startContainer, startBoundaryValue.offset);
    startBoundary.collapse(true);
    startBoundary.insertNode(startMarker);
    const contentWithMarkers = serializeRichEditorRoot(editorClone, false).content;
    const startIndex = contentWithMarkers.indexOf(startToken);
    const endIndex = contentWithMarkers.indexOf(endToken);
    if (startIndex < 0 || endIndex < startIndex + startToken.length) return null;
    return { start: startIndex, end: endIndex - startToken.length };
  }

  function normalizeEditorRangeBoundary(container, offset, edge) {
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const token = element?.closest?.("[data-photo-marker]");
    if (!token || !elements.entryContent.contains(token)) return { container, offset };
    const parent = token.parentNode;
    const tokenIndex = [...parent.childNodes].indexOf(token);
    const after = edge === "end" || offset > 0;
    return { container: parent, offset: tokenIndex + (after ? 1 : 0) };
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
    const units = [];
    const collect = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        units.push({ kind: "text", node, length: node.nodeValue.length });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches("[data-photo-marker]")) {
        units.push({ kind: "photo-marker", node, length: node.dataset.photoMarker.length });
        return;
      }
      [...node.childNodes].forEach(collect);
    };
    [...elements.entryContent.childNodes].forEach(collect);
    const boundaryAround = (node, after) => {
      const parent = node.parentNode;
      const index = [...parent.childNodes].indexOf(node);
      return { node: parent, offset: index + (after ? 1 : 0) };
    };
    const locate = (requestedOffset, edge) => {
      const maximum = units.reduce((total, unit) => total + unit.length, 0);
      const target = Math.max(0, Math.min(maximum, Number(requestedOffset) || 0));
      let traversed = 0;
      for (const unit of units) {
        const end = traversed + unit.length;
        if (unit.kind === "photo-marker") {
          if (target === traversed) return boundaryAround(unit.node, false);
          if (target <= end) return boundaryAround(unit.node, edge === "end" || target === end);
        } else if (target <= end) {
          return { node: unit.node, offset: target - traversed };
        }
        traversed = end;
      }
      return { node: elements.entryContent, offset: elements.entryContent.childNodes.length };
    };
    const start = locate(offsets.start, "start");
    const end = locate(offsets.end, "end");
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    state.editorSelection = range.cloneRange();
  }

  function insertPlainTextAtEditorSelection(text) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!elements.entryContent.contains(range.commonAncestorContainer)) return false;
    const offsets = getSerializedEditorRangeOffsets(range);
    if (!offsets || inputWouldModifyPhotoMarker("insertFromPaste")) {
      elements.editorMessage.textContent = "写真を含む範囲は置き換えられません。";
      return false;
    }
    const editorDocument = serializeRichEditor(false);
    if (editorDocument.content.length - (offsets.end - offsets.start) + String(text || "").length > 200000) {
      elements.editorMessage.textContent = "本文は20万文字以内で入力してください。";
      return false;
    }
    const updatedDocument = replaceTextInRichDocument(editorDocument, offsets.start, offsets.end, text);
    setRichEditorDocument(updatedDocument.content, updatedDocument.contentFormat);
    const caret = offsets.start + String(text || "").length;
    restoreEditorSelectionFromOffsets({ start: caret, end: caret });
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
      if (node.matches("[data-photo-marker]")) {
        append(node.dataset.photoMarker || "", { bold: false, italic: false, underline: false, color: null });
        return;
      }
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

  function setRichEditorDocument(content, contentFormat = null) {
    const text = String(content || "");
    const runs = Array.isArray(contentFormat?.runs) ? contentFormat.runs : [];
    const fragment = document.createDocumentFragment();
    for (const token of tokenizeEditorDocument(text, runs)) {
      if (token.kind === "photo-marker") {
        fragment.append(createEditorPhotoMarker(token));
      } else if (token.marks) {
        fragment.append(createFormattedTextSpan(token.text, token.marks));
      } else {
        fragment.append(document.createTextNode(token.text));
      }
    }
    elements.entryContent.replaceChildren(fragment);
    state.editorSelection = null;
    state.editorSelectionOffsets = null;
  }

  function createEditorPhotoMarker(token) {
    const marker = document.createElement("span");
    marker.className = "editor-photo-marker";
    marker.contentEditable = "false";
    marker.dataset.photoId = token.id;
    marker.dataset.photoMarker = token.marker;
    marker.textContent = token.marker;
    marker.setAttribute("aria-label", "写真");
    return marker;
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
      if (photo.existing) {
        state.editorDeletedPhotoIds.add(photo.id);
        state.editorPendingPhotoDeletionIds.add(photo.id);
      }
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
      photo.removed=true;photo.originalFile=photo.displayBlob=photo.thumbnailBlob=null;photo.fileName="";
    }
    state.editorPhotos = [];
    state.editorDeletedPhotoIds.clear();
    state.editorPendingPhotoDeletionIds.clear();
    state.photoUploadSessionId = null;
    state.photoUploadSessionTiming = null;
    state.photoUploadSessionPromise = null;
    state.photoUploadTargetEntryId = null;
    state.photoUploadCommitted = false;
    state.photoUploadPendingCount = 0;
    state.photoUploading = false;
    state.photoUploadActiveTasks.clear();
    elements.editorPhotoList?.replaceChildren();
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

  function hasEditorChanges() {
    return state.editorDirty || state.editorWeather !== (state.editorSourceEntry?.weather ?? null);
  }

  function appendTitleWeather(title, weather) {
    title.classList.remove("entry-weather-title");
    const icon = createWeatherIcon(weather);
    if (!icon) return;
    const text = document.createElement("span");
    text.className = "entry-weather-title-text";
    text.append(...title.childNodes);
    title.replaceChildren(text, icon);
    title.classList.add("entry-weather-title");
  }

  function renderWeatherButton() {
    const label = WEATHER_LABELS[state.editorWeather] || "未設定";
    elements.weatherButton.replaceChildren(createWeatherIcon(state.editorWeather) || document.createTextNode("天気"));
    elements.weatherButton.setAttribute("aria-label", `天気を選択：${label}`);
    elements.weatherButton.title = `天気を選択：${label}`;
    for (const option of elements.weatherMenu.children) {
      option.setAttribute("aria-checked", String(option.dataset.weather === (state.editorWeather || "")));
    }
  }

  function closeWeatherMenu(restoreFocus = true) {
    const wasOpen = !elements.weatherMenu.hidden;
    elements.weatherMenu.hidden = true;
    elements.weatherButton.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus) elements.weatherButton.focus();
  }

  function setupWeatherPicker() {
    for (const [id, label] of [...Object.entries(WEATHER_LABELS), ["", "未設定に戻す"]]) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.weather = id;
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", "false");
      option.setAttribute("aria-label", label);
      option.title = label;
      option.tabIndex = -1;
      const icon = createWeatherIcon(id) || createUnsetWeatherIcon();
      if (icon) { icon.setAttribute("aria-hidden", "true"); option.append(icon); }
      option.addEventListener("click", () => {
        state.editorWeather = id || null;
        renderWeatherButton();
        closeWeatherMenu();
      });
      elements.weatherMenu.append(option);
    }
    const open = () => {
      renderWeatherButton();
      elements.weatherMenu.hidden = false;
      elements.weatherButton.setAttribute("aria-expanded", "true");
      elements.weatherMenu.querySelector('[aria-checked="true"]').focus();
    };
    elements.weatherButton.addEventListener("click", () => elements.weatherMenu.hidden ? open() : closeWeatherMenu());
    elements.weatherButton.parentElement.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.weatherMenu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeWeatherMenu();
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (elements.weatherMenu.hidden) return open();
        const options = [...elements.weatherMenu.children];
        const current = options.indexOf(document.activeElement);
        const step = { ArrowDown: 3, ArrowUp: -3, ArrowRight: 1, ArrowLeft: -1 }[event.key] || 0;
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (current + step + options.length) % options.length;
        options[next].focus();
      } else if (event.key === "Tab") closeWeatherMenu(false);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!elements.weatherButton.parentElement.contains(event.target)) closeWeatherMenu(false);
    });
  }

  function openEditor(entry = null) {
    if (!state.canManageEntries) return;
    const isDraft = entry?.status === "draft";
    elements.editorMessage.textContent = "";
    elements.editorTitle.textContent = isDraft ? "下書きを編集" : (entry ? "日記を編集" : "新しい日記");
    elements.entryId.value = entry ? String(entry.id) : "";
    elements.entryRevision.value = entry ? String(entry.revision) : "";
    elements.entryStatus.value = isDraft ? "draft" : "published";
    elements.deleteDraftButton.hidden = !isDraft;
    elements.entryDate.value = entry?.entryDate || japanDateString();
    elements.entryTitle.value = entry?.title || "";
    state.editorWeather = Object.hasOwn(WEATHER_LABELS, entry?.weather) ? entry.weather : null;
    closeWeatherMenu(false);
    renderWeatherButton();
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
    dialogs.open("editor-dialog");
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
    const timing = { started: Date.now(), stages: {}, requests: [], photos: [], outcome: "failed" };
    editorSaveTiming = timing;
    const measure = async (stage, operation) => {
      const started = Date.now();
      try { return await operation(); }
      finally { timing.stages[stage] = Date.now() - started; }
    };
    elements.editorMessage.textContent = "";
    setEditorSaveBusy(true, targetStatus === "draft" ? "下書き保存中..." : "投稿中...");
    try {
      await measure("prepare", () => waitForPhotoPreparation());
      const id = Number(elements.entryId.value || 0);
      const editorDocument = serializeRichEditor(true);
      const body = {
        entryDate: elements.entryDate.value,
        title: elements.entryTitle.value,
        weather: state.editorWeather,
        content: editorDocument.content,
        contentFormat: editorDocument.contentFormat,
        tags: parseTags(elements.entryTags.value),
        status: targetStatus,
        excludedPhotoIds: [...state.editorDeletedPhotoIds]
      };
      if (id) body.revision = Number(elements.entryRevision.value);
      else body.requestId = state.entryCreateRequestId || (state.entryCreateRequestId = crypto.randomUUID().toLowerCase());

      const pendingPhotos = state.editorPhotos.filter((photo) => !photo.existing && body.content.includes(photoMarker(photo.id)));
      timing.photos = pendingPhotos;
      if (pendingPhotos.length) {
        setEditorSaveBusy(true, "写真の保存完了を待っています...");
        await measure("uploadWait", () => ensurePhotosUploaded(pendingPhotos));
      }
      timing.uploadSession = state.photoUploadSessionTiming;

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
      let saved = await measure("entrySave", () => id
        ? api(`/entries/${id}`, { method: "PUT", body: provisionalBody })
        : createEntryIdempotently(provisionalBody));
      const failures = [];
      // Persisted exclusions also contain historical/already-deleted photos and
      // draft intent. Only this editor's explicit removals request a DELETE.
      const deletedPhotoIds = [...state.editorPendingPhotoDeletionIds];
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
      if (promotedEditDraft) {
        // The publish transaction already applied draft exclusions. Do not
        // replay them if a later photo commit fails and the editor is retried.
        for (const photoId of deletedPhotoIds) {
          state.editorPendingPhotoDeletionIds.delete(photoId);
          state.editorDeletedPhotoIds.delete(photoId);
        }
      }
      for (let index = 0; index < deletionsToApply.length; index += 1) {
        const photoId = deletionsToApply[index];
        setEditorSaveBusy(true, `画像を削除中 ${index + 1}/${deletionsToApply.length}`);
        try {
          await deletePhoto(photoId);
          state.editorPendingPhotoDeletionIds.delete(photoId);
          state.editorDeletedPhotoIds.delete(photoId);
        } catch (error) {
          failures.push(`画像の削除：${error.message}`);
        }
      }
      if (state.photoUploadSessionId && !state.photoUploadCommitted) {
        setEditorSaveBusy(true, "写真を日記へ反映しています...");
        try {
          const committedPhotos = await measure("photoCommit", () => commitStagedPhotos(saved.entry.id, pendingPhotos));
          const committedById = new Map(committedPhotos.map((photo) => [photo.id, photo]));
          for (const photo of pendingPhotos) {
            photo.existing = true;
            Object.assign(photo, committedById.get(photo.id) || {});
            releaseUploadedPhotoPayload(photo, { releasePreview: Boolean(photo.thumbnailUrl) });
          }
          if (pendingPhotos.length) {
            setEditorSaveBusy(true, "写真を本文へ反映しています...");
            saved = await measure("finalize", () => finalizeCommittedPhotoEntry(saved.entry.id, body, saved.entry));
            elements.entryRevision.value = String(saved.entry.revision);
            elements.entryStatus.value = saved.entry.status;
            state.editorSourceEntry = saved.entry;
          }
        } catch (error) {
          failures.push(`写真の反映：${error.message}`);
        }
      }
      if (failures.length) {
        timing.outcome = "partial";
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
      await closeEditorDialog();
      await measure("refresh", () => Promise.all([loadMeta(), loadEntries(true)]));
      timing.outcome = "saved";
      return true;
    } catch (error) {
      elements.editorMessage.textContent = error.message;
      return false;
    } finally {
      setEditorSaveBusy(false);
      editorSaveTiming = null;
      // One local summary per save, without entry contents, file names or IDs.
      console.info("Diary save timing", JSON.stringify({
        elapsedMs: Date.now() - timing.started,
        outcome: timing.outcome,
        stages: timing.stages,
        requests: timing.requests,
        uploadSession: timing.uploadSession || state.photoUploadSessionTiming,
        photos: timing.photos.map((photo) => ({ preparationMs: photo.preparationMs, ...photo.uploadMetrics }))
      }));
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
      && (entry.weather ?? null) === (payload.weather ?? null)
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
    state.editorSaving = busy;
    elements.weatherButton.disabled = busy;
    if (busy) closeWeatherMenu(false);
    elements.saveEntryButton.disabled = busy;
    elements.saveDraftButton.disabled = busy;
    elements.cancelEntryButton.disabled = busy;
    elements.deleteDraftButton.disabled = busy;
    elements.editorLeaveSaveDraft.disabled = busy;
    if (busy) {
      if (label) elements.editorMessage.textContent = label;
    }
    elements.saveEntryButton.textContent = "投稿";
    elements.saveDraftButton.textContent = "下書き保存";
  }

  async function openCameraRoll() {
    updatePhotoSortButton();
    dialogs.open("camera-roll-dialog");
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
    const months = result.months || [];
    const totalCount = months.reduce((total, item) => total + Number(item.count || 0), 0);
    elements.photoMonthFilter.replaceChildren(createOption("", `すべて（${totalCount}）`), ...months.map((item) => (
      createOption(item.value, `${formatMonth(item.value)}（${item.count}）`)
    )));
    elements.photoMonthFilter.value = monthValue;
    updatePhotoSortButton();
  }

  function updatePhotoSortButton() {
    const oldest = state.photoOrder === "oldest";
    elements.photoSortButton.hidden = !state.photoMonth;
    elements.photoSortButton.setAttribute("aria-pressed", String(oldest));
    const label = oldest ? "古い順で表示中。新しい順に並べ替え" : "新しい順で表示中。古い順に並べ替え";
    elements.photoSortButton.setAttribute("aria-label", label);
    elements.photoSortButton.title = label;
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

  function cancelCameraRollLoad() {
    window.clearTimeout(state.photoSearchTimer);
    state.photoRequestId++;
    state.photoLoading = false;
    elements.cameraRollMore.disabled = false;
  }

  async function loadPhotos(reset) {
    if (!reset && (state.photoLoading || state.photos.length >= CAMERA_ROLL_MAX_PHOTOS)) return;
    const requestId = ++state.photoRequestId;
    state.photoLoading = true;
    elements.cameraRollMore.disabled = true;
    if (reset) {
      state.photoOffset = 0;
      state.photos = [];
      state.photoHasMore = false;
      elements.cameraRollMore.hidden = true;
      elements.cameraRollGrid.replaceChildren();
      elements.cameraRollStatus.textContent = "写真を読み込んでいます...";
    }
    // Keep opening light. Expand progressively, with the same total bound for
    // all months and filtered results, including retries and repeated clicks.
    const maxAdditional = reset ? 48 : CAMERA_ROLL_MAX_PHOTOS - state.photos.length;
    const parameters = new URLSearchParams();
    if (state.photoEntryQuery) parameters.set("entryQuery", state.photoEntryQuery);
    if (state.photoMonth) {
      parameters.set("month", state.photoMonth);
      parameters.set("order", state.photoOrder);
    }
    if (state.photoFileNameQuery) parameters.set("fileName", state.photoFileNameQuery);
    let added = 0;
    const started = performance.now();
    try {
      do {
        const limit = Math.min(reset ? 48 : CAMERA_ROLL_PAGE_SIZE, maxAdditional - added);
        parameters.set("limit", String(limit));
        parameters.set("offset", String(state.photoOffset));
        const result = await api(`/photos?${parameters}`);
        if (requestId !== state.photoRequestId) return;
        const appendFrom = state.photos.length;
        const photos = result.photos.slice(0, limit);
        state.photos.push(...photos);
        state.photoOffset += photos.length;
        added += photos.length;
        state.photoHasMore = (Boolean(result.hasMore) || result.photos.length > limit) && photos.length > 0;
        renderCameraRoll(appendFrom);
      } while (state.photoHasMore && added < maxAdditional
        && performance.now() - started < CAMERA_ROLL_LOAD_BUDGET_MS);
    } catch (error) {
      if (requestId === state.photoRequestId) elements.cameraRollStatus.textContent = error.message;
    } finally {
      if (requestId === state.photoRequestId) {
        state.photoLoading = false;
        elements.cameraRollMore.disabled = false;
      }
    }
  }

  function renderCameraRoll(appendFrom = 0) {
    if (!state.photos.length) {
      elements.cameraRollGrid.replaceChildren(createEmpty("該当する写真はありません。"));
    } else {
      if (!appendFrom) elements.cameraRollGrid.replaceChildren();
      const cards = state.photos.slice(appendFrom).map((photo, offset) => {
        const index = appendFrom + offset;
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
      });
      elements.cameraRollGrid.append(...cards);
    }
    const atLimit = state.photos.length >= CAMERA_ROLL_MAX_PHOTOS;
    elements.cameraRollStatus.textContent = `${state.photos.length}件の写真を表示しています。`
      + (atLimit && state.photoHasMore ? "表示上限に達しました。年月や検索条件で絞り込んでください。" : "");
    elements.cameraRollMore.hidden = !state.photoHasMore || atLimit;
  }

  function handleCameraRollClick(event) {
    const button = event.target.closest("[data-photo-index]");
    if (!button) return;
    const index = Number(button.dataset.photoIndex);
    if (!state.photos[index]) return;
    openPhotoViewer(state.photos, index);
  }

  async function openPhotoViewer(photos, index) {
    if (!photos?.length || index < 0 || index >= photos.length) return;
    const generation = sessionGeneration;
    const request = ++viewerOpenRequest;
    try { await loadPhotoViewer(); } catch (error) { showToast(error.message); return; }
    if (generation !== sessionGeneration || request !== viewerOpenRequest || elements.appView.hidden) return;
    state.viewerPhotos = photos;
    state.viewerIndex = index;
    photoViewer.render();
    dialogs.open("photo-viewer-dialog");
  }

  function closeCameraRollDialog(afterClose = null) {
    return dialogs.close("camera-roll-dialog", { after: typeof afterClose === "function" ? afterClose : undefined });
  }

  function finishCameraRollClose() {
    viewerOpenRequest += 1;
    cancelCameraRollLoad();
    if (elements.cameraRollDialog.open) elements.cameraRollDialog.close();

  }

  function closePhotoViewerDialog(afterClose = null) {
    return dialogs.close("photo-viewer-dialog", { after: typeof afterClose === "function" ? afterClose : undefined });
  }

  function finishPhotoViewerClose() {
    viewerOpenRequest += 1;
    photoViewer?.cancelLoad();
    if (elements.photoViewerDialog.open) elements.photoViewerDialog.close();
    elements.photoViewerImage.removeAttribute("src");
    elements.photoViewerImage.hidden = true;
    elements.photoViewerStatus.hidden = true;
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
    dialogs.open("date-wheel-dialog");
  }

  function closeDateWheel() {
    return dialogs.close("date-wheel-dialog");
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
    dialogs.open("delete-confirm-dialog");
  }

  function requestDraftDeletion() {
    const draft = state.editorSourceEntry;
    if (!draft || draft.status !== "draft" || !Number(elements.entryId.value || 0)) return;
    state.deleteMode = "draft";
    elements.deleteConfirmTitle.textContent = "この下書きを削除しますか？";
    elements.deleteConfirmMessage.textContent = "保存済みの下書きを削除します。この操作は取り消せません。";
    elements.deleteConfirmYes.textContent = "下書きを削除";
    dialogs.open("delete-confirm-dialog");
  }

  function requestPermanentDeletion() {
    if (!state.activeEntry || !state.canPermanentlyDelete || !state.activeEntry.deletedAt) return;
    state.deleteMode = "permanent";
    elements.deleteConfirmTitle.textContent = "本当に完全削除しますか？";
    elements.deleteConfirmMessage.textContent = "この操作は取り消せません。";
    elements.deleteConfirmYes.textContent = "完全に削除";
    dialogs.open("delete-confirm-dialog");
  }

  function closeDeleteConfirmation() {
    return dialogs.close("delete-confirm-dialog");
  }

  async function confirmEntryDeletion() {
    const mode = state.deleteMode;
    if (!await closeDeleteConfirmation()) return;
    if (mode === "draft") await deleteActiveDraft();
    else if (mode === "permanent") await permanentlyDeleteActiveEntry();
    else if (mode === "trash") await moveActiveEntryToTrash();
  }

  async function deleteActiveDraft() {
    const draft = state.editorSourceEntry;
    if (!draft || draft.status !== "draft") return;
    setEditorSaveBusy(true, "下書きを削除中...");
    try {
      await cancelEditorPhotoUploadSession();
      await api(`/drafts/${draft.id}`, {
        method: "DELETE",
        body: { revision: Number(elements.entryRevision.value) }
      });
      state.editorDirty = false;
      await closeEditorDialog();
      showToast("下書きを削除しました。");
      state.drafts = true;
      updateFilterControls();
      await Promise.all([loadMeta(), loadEntries(true)]);
    } catch (error) {
      elements.editorMessage.textContent = error.message;
    } finally {
      setEditorSaveBusy(false);
    }
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
    updateFavoritesLink();
  }

  function updateFavoritesLink() {
    if (!elements.favoritesLink) return;
    elements.favoritesLink.href = state.favoritePage ? `${BASE_PATH}/` : `${BASE_PATH}/favorites/`;
    elements.favoritesLink.setAttribute("aria-label", state.favoritePage ? "お気に入り表示を解除して日記へ戻る" : "お気に入りを開く");
    if (state.favoritePage) elements.favoritesLink.setAttribute("aria-current", "page");
    else elements.favoritesLink.removeAttribute("aria-current");
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
    const generation = sessionGeneration;
    const timing = editorSaveTiming;
    const started = Date.now();
    const headers = new Headers(options.headers);
    const init = {
      method: options.method || "GET",
      headers,
      credentials: "same-origin",
      signal: options.signal
    };
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    if (init.method !== "GET") headers.set("X-Diary-Request", "1");

    let response;
    try {
      try {
        response = await fetch(`${BASE_PATH}/api${path}`, init);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        const error = new Error("通信結果を確認できませんでした。通信状態を確認して、もう一度お試しください。");
        error.transportOutcomeUnknown = true;
        error.cause = cause;
        throw error;
      }
      let result;
      try {
        result = await response.json();
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (!response.ok) result = {};
        else {
          const error = new Error("通信結果を確認できませんでした。通信状態を確認して、もう一度お試しください。");
          error.transportOutcomeUnknown = true;
          error.cause = cause;
          throw error;
        }
      }
      if (!response.ok) {
        if (response.status === 401 && generation === sessionGeneration && path !== "/login" && path !== "/passkey/handoff"
            ) {
          resetState();
          showLogin("ログインの有効期限が切れました。");
        }
        const error = new Error(result.error || "処理を完了できませんでした。");
        error.status = response.status;
        throw error;
      }
      if (generation !== sessionGeneration) throw new Error("ログイン状態が変わりました。");
      return result;
    } finally {
      if (timing || options.onTiming) {
        const stage = path.startsWith("/photo-upload-sessions") ? "photo-session"
          : path.startsWith("/entries") ? "entry" : path === "/meta" ? "meta" : "other";
        const sample = { stage, method: init.method, status: response?.status || 0,
          elapsedMs: Date.now() - started, serverTiming: response?.headers.get("Server-Timing") || "" };
        if (timing && timing.requests.length < 40) timing.requests.push(sample);
        options.onTiming?.(sample);
      }
    }
  }

  function createTagGroup(tags, searchTerms = []) {
    const group = document.createElement("div");
    group.className = "diary-tags";
    group.append(...createTagElements(tags, searchTerms));
    return group;
  }

  function tagSortKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
      .toLocaleLowerCase("ja-JP");
  }

  function createTagElements(tags, searchTerms = []) {
    return (tags || []).map((tag) => {
      const link = createTagLink(tag, `#${tag}`);
      if (!searchTerms.length) return link;
      // Match each tag independently; the display-only # is not searchable.
      const label = document.createElement("span");
      label.textContent = tag;
      highlightSearchTerms(label, searchTerms);
      link.replaceChildren(document.createTextNode("#"), label);
      return link;
    });
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
    updateFavoritesLink();
    configureDiaryReturnNavigation();
  }

  function configureDiaryReturnNavigation() {
    // Fresh accesses discard retained tokens before accepting a validated handoff.
    // Reload and history navigation keep the token owned by their current entry.
    try {
      const newNavigation = isNewDiaryNavigation();
      if (newNavigation && window.history.state?.[RETURN_NAVIGATION_KEY] !== undefined) {
        const historyState = { ...window.history.state };
        delete historyState[RETURN_NAVIGATION_KEY];
        window.history.replaceState(historyState, "", window.location.href);
      }
      const storedNavigation = window.sessionStorage.getItem(RETURN_NAVIGATION_KEY);
      window.sessionStorage.removeItem(RETURN_NAVIGATION_KEY);
      const navigation = JSON.parse(storedNavigation || "null");
      const returnView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
      // Measure at navigation start so a slow bootstrap cannot expire a valid handoff.
      const navigationAge = window.performance.timeOrigin - navigation?.savedAt;
      if (newNavigation && navigation?.destinationPath === window.location.pathname
        && isDiaryListPath(navigation.sourcePath) && isDiaryReturnReferrer(navigation.sourcePath)
        && Number.isFinite(navigation.savedAt) && navigationAge >= 0 && navigationAge <= RETURN_NAVIGATION_MAX_AGE_MS
        && returnView?.version === 2 && returnView.savedAt === navigation.savedAt
        && returnView.routePath === navigation.sourcePath && returnView.destinationPath === navigation.destinationPath) {
        window.history.replaceState({
          ...(window.history.state || {}),
          [RETURN_NAVIGATION_KEY]: navigation.savedAt
        }, "", window.location.href);
      }
    } catch {
      // 遷移を確認できない場合は通常のリンクで戻ります。
    }
    updateDiaryReturnNavigation();
  }

  function isOwnedDiaryReturnView(returnView) {
    return Boolean(state.role && state.accountName && state.activeHouseholdId)
      && returnView.accountName === state.accountName
      && returnView.householdId === state.activeHouseholdId;
  }

  function updateDiaryReturnNavigation() {
    elements.tagPageBack.href = `${BASE_PATH}/`;
    elements.tagPageBack.textContent = "← 日記へ戻る";
    if (elements.tagPageBack.hidden) return;
    let returnView = null;
    try {
      returnView = JSON.parse(window.sessionStorage.getItem(RETURN_VIEW_STORAGE_KEY) || "null");
    } catch {
      return;
    }
    if (returnView?.version !== 2 || returnView.destinationPath !== window.location.pathname
      || !isOwnedDiaryReturnView(returnView)) return;
    // Display a source only when this history entry owns the accepted navigation.
    if (!Number.isFinite(returnView.savedAt)
      || window.history.state?.[RETURN_NAVIGATION_KEY] !== returnView.savedAt) return;
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
    return [...new Set(String(value || "").split(/[、,，]/).map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))].slice(0, 100);
  }

  function formatDate(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!year || !month || !day) return value;
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    return `${year}年${month}月${day}日（${weekday}）`;
  }

  function formatPublishedDateTime(value) {
    const source = String(value || "");
    const date = new Date(source.replace(" ", "T") + (/[zZ]$|[+-]\d{2}:\d{2}$/.test(source) ? "" : "Z"));
    if (Number.isNaN(date.getTime())) return value || "不明";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
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
    const labelElement = button.querySelector?.(".passkey-login-label");
    if (labelElement) {
      if (busy) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    }
    (labelElement || button).textContent = label;
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
    cancelPositionRestoration();
    elements.tagPageBack.href = `${BASE_PATH}/`;
    elements.tagPageBack.textContent = "← 日記へ戻る";
    for (const key of [RETURN_VIEW_STORAGE_KEY, RETURN_NAVIGATION_KEY]) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Storage may be unavailable; ownership checks still reject the old source.
      }
    }
    try {
      const historyState = { ...(window.history.state || {}) };
      delete historyState[RETURN_VIEW_HISTORY_KEY];
      delete historyState[RETURN_NAVIGATION_KEY];
      window.history.replaceState(historyState, "", window.location.href);
    } catch {
      // A retained history snapshot is still checked against the next session.
    }
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    loginAttempt += 1;
    setBusy(document.querySelector("#passkey-login"), false, "パスキーでログイン");
    sessionGeneration += 1;
    activeSessionContext = "";
    elements.entryForm.reset();elements.entryContent.replaceChildren();
    for(const input of document.querySelectorAll('dialog input,dialog textarea'))input.value='';
    for(const key of ['detailDate','detailPublishedAt','detailTitle','detailAuthor','detailDeletion','detailTags','detailContent','deleteConfirmMessage','editorMessage','entryTagSuggestions'])elements[key]?.replaceChildren();
    elements.entryList.replaceChildren();
    elements.archiveList.replaceChildren();
    elements.tagList.replaceChildren();
    elements.householdSwitcher.replaceChildren();
    elements.householdSwitcherWrap.hidden = true;
    elements.investmentSection.hidden = true;
    finishPhotoViewerClose();
    dialogs.reset();
    cancelPendingEntrySearch();
    state.searchComposing = false;
    resetHeaderVisibilityTracking();
    state.role = null;
    state.accountName = null;
    state.householdId = null;
    state.activeHouseholdId = null;
    state.isGlobalOwner = false;
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
    cancelCameraRollLoad();
    state.photoEntryQuery = "";
    state.photoMonth = "";
    state.photoOrder = "newest";
    updatePhotoSortButton();
    state.photoFileNameQuery = "";
    state.viewerPhotos = [];
    state.viewerIndex = -1;
    finishPhotoPickerInteraction();
    state.editorDirty = false;
    state.editorSourceEntry = null;
    state.entryCreateRequestId = null;
    state.dateDraft = null;
    state.dateWheelTarget = null;
    state.favoriteRequestPending = false;
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
}

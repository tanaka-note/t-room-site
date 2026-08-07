(() => {
  const state = { session: null, accounts: [], summary: null, dateDraft: null, dateWheelTimers: {} };
  const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
  const integerFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
  const documentLabels = { invoice: "請求書", payment_notice: "支払通知書" };
  const categoryLabels = { purchase: "買い物", discount: "値引き", income: "入金", offset: "相殺", other: "その他" };
  const categoryOptions = {
    invoice: ["purchase", "discount", "income", "offset", "other"],
    payment_notice: ["purchase", "offset", "income", "other"]
  };
  const settlementDirectionLabels = { incoming: "入金", outgoing: "着金" };
  const settlementMethodLabels = {
    bank_transfer: "振込", cash: "現金", offset: "相殺", other: "その他", unspecified: "未設定"
  };
  const REMEMBER_LOGIN_KEY = "troom-billing-remember-login";
  const SAVED_LOGIN_ID_KEY = "troom-billing-login-id";

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    bindEvents();
    restoreLoginPreference();
    el["month-input"].value = japanToday().slice(0, 7);
    el["print-date"].textContent = formatDateJp(japanToday());
    try {
      const session = await api("/session");
      if (session.authenticated) await enterApp(session);
    } catch {
      showLogin();
    }
  }

  function bindEvents() {
    el["login-form"].addEventListener("submit", login);
    el["logout-button"].addEventListener("click", logout);
    el["password-toggle"].addEventListener("click", togglePassword);
    el["month-input"].addEventListener("change", loadSummary);
    el["account-select"].addEventListener("change", changeAccount);
    el["document-filter"].addEventListener("change", renderSummary);
    el["print-button"].addEventListener("click", () => window.print());
    el["new-entry-button"].addEventListener("click", () => openEntryDialog());
    el["logs-button"].addEventListener("click", openLogs);
    el["logs-account-filter"].addEventListener("change", loadLogs);
    el["entry-document-type"].addEventListener("change", () => updateCategoryOptions());
    el["entry-category"].addEventListener("change", updateEntryMode);
    el["entry-amount"].addEventListener("input", (event) => {
      if (!event.isComposing) formatYenInput(el["entry-amount"], false);
    });
    el["entry-amount"].addEventListener("compositionend", () => formatYenInput(el["entry-amount"], false));
    el["today-button"].addEventListener("click", setEntryDateToToday);
    el["entry-date"].addEventListener("pointerdown", handleDatePointerDown);
    el["entry-date"].addEventListener("keydown", handleDateKeydown);
    el["date-wheel-cancel"].addEventListener("click", closeDateWheel);
    el["date-wheel-done"].addEventListener("click", applyDateWheel);
    el["date-wheel-dialog"].addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDateWheel();
    });
    bindDateWheel(el["date-wheel-year"], "year");
    bindDateWheel(el["date-wheel-month"], "month");
    bindDateWheel(el["date-wheel-day"], "day");
    el["entry-form"].addEventListener("submit", saveEntry);
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
      document.getElementById(button.dataset.closeDialog).close();
    }));
    el["entries-body"].addEventListener("click", handleEntryAction);
    el["settlements-card"].addEventListener("click", openSettlements);
    el["settlements-body"].addEventListener("click", handleSettlementAction);
  }

  async function login(event) {
    event.preventDefault();
    el["login-error"].textContent = "";
    const submit = event.submitter;
    const loginId = el["login-id"].value;
    const password = el["login-password"].value;
    submit.disabled = true;
    try {
      const session = await api("/login", {
        method: "POST",
        body: { loginId, password }
      });
      await saveLoginPreference(loginId, password);
      el["login-password"].value = "";
      await enterApp(session);
    } catch (error) {
      el["login-error"].textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function logout() {
    try { await api("/logout", { method: "POST", body: {} }); } catch { /* local view still closes */ }
    state.session = null;
    showLogin();
  }

  async function enterApp(session) {
    state.session = session;
    el["login-view"].hidden = true;
    el["app-view"].hidden = false;
    el["account-label"].textContent = `${session.accountName}${session.role === "owner" ? "（管理者）" : ""}`;
    document.body.classList.toggle("is-owner", session.role === "owner");
    document.querySelectorAll(".owner-only").forEach((node) => { node.hidden = session.role !== "owner"; });
    const result = await api("/accounts");
    state.accounts = result.accounts;
    fillAccountSelects();
    applyPreferredDocumentType();
    await loadSummary();
  }

  function showLogin() {
    el["app-view"].hidden = true;
    el["login-view"].hidden = false;
    (el["login-id"].value ? el["login-password"] : el["login-id"]).focus();
  }

  function restoreLoginPreference() {
    try {
      const remember = localStorage.getItem(REMEMBER_LOGIN_KEY) !== "false";
      el["remember-login"].checked = remember;
      if (remember) el["login-id"].value = localStorage.getItem(SAVED_LOGIN_ID_KEY) || "";
    } catch {
      el["remember-login"].checked = true;
    }
  }

  async function saveLoginPreference(loginId, password) {
    const remember = el["remember-login"].checked;
    try {
      localStorage.setItem(REMEMBER_LOGIN_KEY, String(remember));
      if (remember) localStorage.setItem(SAVED_LOGIN_ID_KEY, loginId);
      else localStorage.removeItem(SAVED_LOGIN_ID_KEY);
    } catch {
      // 端末側で保存が禁止されていても、通常のログインは続行します。
    }
    if (!remember) {
      if (navigator.credentials?.preventSilentAccess) await navigator.credentials.preventSilentAccess().catch(() => {});
      return;
    }

    if (!navigator.credentials?.store || typeof window.PasswordCredential !== "function") return;
    try {
      await navigator.credentials.store(new PasswordCredential({ id: loginId, password }));
    } catch {
      // 保存の可否と確認画面はブラウザのパスワード管理機能に任せます。
    }
  }

  function fillAccountSelects() {
    const options = state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.displayName)}</option>`).join("");
    [el["account-select"], el["entry-account"]].forEach((select) => { select.innerHTML = options; });
    const ownerOption = state.session.role === "owner"
      ? `<option value="${escapeHtml(state.session.accountId)}">${escapeHtml(state.session.accountName)}</option>`
      : "";
    el["logs-account-filter"].innerHTML = `<option value="">全体</option>${ownerOption}${options}`;
    if (state.session.role === "owner") {
      el["account-select-label"].hidden = false;
    } else {
      el["account-select"].value = state.session.accountId;
      el["account-select-label"].hidden = true;
    }
  }

  async function changeAccount() {
    applyPreferredDocumentType();
    await loadSummary();
  }

  function applyPreferredDocumentType() {
    const accountId = state.session.role === "owner" ? el["account-select"].value : state.session.accountId;
    el["document-filter"].value = accountId === "masami" ? "payment_notice" : "invoice";
  }

  async function loadSummary() {
    const accountId = state.session.role === "owner" ? el["account-select"].value : state.session.accountId;
    const month = el["month-input"].value || japanToday().slice(0, 7);
    try {
      state.summary = await api(`/summary?accountId=${encodeURIComponent(accountId)}&month=${encodeURIComponent(month)}`);
      renderSummary();
    } catch (error) {
      alert(error.message);
    }
  }

  function renderSummary() {
    const summary = state.summary;
    if (!summary) return;
    const documentType = el["document-filter"].value;
    const visibleEntries = summary.entries.filter((entry) => entry.documentType === documentType);
    el["report-month"].textContent = formatMonthJp(summary.month);
    el["document-title"].textContent = documentLabels[documentType];
    el["report-account"].textContent = `${summary.account.displayName} 様`;
    el["print-button"].textContent = `${documentLabels[documentType]}をPDF保存`;
    el["document-total-label"].textContent = documentType === "invoice" ? "請求合計" : "支払合計";
    const documentTotal = visibleEntries.reduce((total, entry) => total + entry.amountYen, 0);
    renderYen(el["document-total"], documentTotal);
    renderYen(el["opening-balance"], summary.openingBalanceYen);
    renderYen(el["closing-balance"], summary.closingBalanceYen);
    el["incoming-total"].textContent = formatYen(summary.settlementTotals.incomingYen);
    el["outgoing-total"].textContent = formatYen(summary.settlementTotals.outgoingYen);
    el["settlements-card"].setAttribute(
      "aria-label",
      `当月入出金。入金${formatYen(summary.settlementTotals.incomingYen)}、着金${formatYen(summary.settlementTotals.outgoingYen)}。履歴を見る`
    );
    el["empty-message"].hidden = visibleEntries.length > 0;
    el["entries-body"].innerHTML = visibleEntries.map((entry) => {
      const signClass = entry.amountYen >= 0 ? "positive" : "negative";
      return `<tr>
        <td data-label="日付">${escapeHtml(formatDateShort(entry.entryDate))}</td>
        <td data-label="区分">${categoryLabels[entry.category] || "その他"}</td>
        <td data-label="内容"><strong>${escapeHtml(entry.description)}</strong></td>
        <td data-label="備考">${entry.note ? escapeHtml(entry.note) : "—"}</td>
        <td data-label="金額" class="amount ${signClass}">${formatYen(entry.amountYen)}</td>
        <td class="row-actions owner-only no-print" ${state.session.role !== "owner" ? "hidden" : ""}>
          <button type="button" data-action="edit" data-id="${entry.id}">編集</button>
          <button type="button" data-action="delete" data-id="${entry.id}">削除</button>
        </td>
      </tr>`;
    }).join("");
  }

  function openEntryDialog(entry = null, settlement = null) {
    el["entry-form"].reset();
    el["entry-error"].textContent = "";
    el["entry-id"].value = entry?.id || settlement?.id || "";
    el["entry-record-type"].value = settlement ? "settlement" : (entry ? "entry" : "");
    el["entry-dialog-title"].textContent = entry || settlement ? "明細を編集" : "明細を追加";
    el["entry-account"].value = state.summary.account.id;
    el["entry-document-type"].value = entry?.documentType || el["document-filter"].value;
    el["entry-date"].value = entry?.entryDate || settlement?.settlementDate || japanToday();
    el["entry-category"].disabled = false;
    updateCategoryOptions(settlement ? "income" : (entry?.category || "purchase"));
    if (settlement) {
      el["entry-category"].replaceChildren(new Option("入金", "income"));
      el["entry-category"].disabled = true;
    }
    el["entry-amount"].value = entry || settlement ? formatInteger(Math.abs((entry || settlement).amountYen)) : "";
    el["entry-description"].value = entry?.description || "";
    el["entry-note"].value = entry?.note || settlement?.note || "";
    el["other-direction"].value = entry?.category === "other" && entry.amountYen < 0 ? "minus" : "plus";
    el["settlement-direction"].value = settlement?.direction || "incoming";
    el["settlement-method"].value = settlement?.method === "unspecified" ? "other" : (settlement?.method || "bank_transfer");
    updateEntryMode();
    el["entry-dialog"].showModal();
  }

  async function saveEntry(event) {
    event.preventDefault();
    const id = el["entry-id"].value;
    const isSettlement = el["entry-category"].value === "income" || el["entry-record-type"].value === "settlement";
    const accountId = el["entry-account"].value;
    const entryDate = el["entry-date"].value;
    if (isSettlement) {
      const payload = {
        accountId,
        settlementDate: entryDate,
        direction: el["settlement-direction"].value,
        method: el["settlement-method"].value,
        amountYen: parseYenInput(el["entry-amount"].value),
        note: el["entry-note"].value
      };
      try {
        await api(id ? `/settlements/${id}` : "/settlements", { method: id ? "PUT" : "POST", body: payload });
        el["entry-dialog"].close();
        el["account-select"].value = payload.accountId;
        el["month-input"].value = payload.settlementDate.slice(0, 7);
        await loadSummary();
        if (el["settlements-dialog"].open) renderSettlements();
      } catch (error) {
        el["entry-error"].textContent = error.message;
      }
      return;
    }
    const payload = {
      accountId,
      documentType: el["entry-document-type"].value,
      entryDate,
      category: el["entry-category"].value,
      otherDirection: el["other-direction"].value,
      amountYen: parseYenInput(el["entry-amount"].value),
      description: el["entry-description"].value,
      note: el["entry-note"].value
    };
    try {
      await api(id ? `/entries/${id}` : "/entries", { method: id ? "PUT" : "POST", body: payload });
      el["entry-dialog"].close();
      el["account-select"].value = payload.accountId;
      el["document-filter"].value = payload.documentType;
      el["month-input"].value = payload.entryDate.slice(0, 7);
      await loadSummary();
    } catch (error) {
      el["entry-error"].textContent = error.message;
    }
  }

  function handleEntryAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const entry = state.summary.entries.find((item) => item.id === Number(button.dataset.id));
    if (!entry) return;
    if (button.dataset.action === "edit") openEntryDialog(entry);
    if (button.dataset.action === "delete") deleteEntry(entry);
  }

  async function deleteEntry(entry) {
    if (!confirm(`「${entry.description}」を削除しますか？`)) return;
    try {
      await api(`/entries/${entry.id}`, { method: "DELETE", body: {} });
      await loadSummary();
    } catch (error) {
      alert(error.message);
    }
  }

  function openSettlements() {
    renderSettlements();
    el["settlements-dialog"].showModal();
  }

  function renderSettlements() {
    const summary = state.summary;
    if (!summary) return;
    el["settlements-dialog-context"].textContent = `${summary.account.displayName}・${formatMonthJp(summary.month)}`;
    el["settlements-body"].innerHTML = summary.settlements.map((settlement) => `<tr>
      <td data-label="日付">${escapeHtml(formatDateShort(settlement.settlementDate))}</td>
      <td data-label="種別"><strong>${escapeHtml(settlementDirectionLabels[settlement.direction] || "入出金")}</strong></td>
      <td data-label="支払い方法">${escapeHtml(settlementMethodLabels[settlement.method] || "その他")}</td>
      <td data-label="金額" class="amount">${formatYen(settlement.amountYen)}</td>
      <td data-label="備考">${settlement.note ? escapeHtml(settlement.note) : "—"}</td>
      <td class="row-actions owner-only" ${state.session.role !== "owner" ? "hidden" : ""}>
        <button type="button" data-settlement-action="edit" data-id="${settlement.id}">編集</button>
        <button type="button" data-settlement-action="delete" data-id="${settlement.id}">削除</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6">この月の入出金履歴はありません。</td></tr>`;
  }

  function handleSettlementAction(event) {
    const button = event.target.closest("button[data-settlement-action]");
    if (!button) return;
    const settlement = state.summary.settlements.find((item) => item.id === Number(button.dataset.id));
    if (!settlement) return;
    if (button.dataset.settlementAction === "edit") openEntryDialog(null, settlement);
    if (button.dataset.settlementAction === "delete") deleteSettlement(settlement);
  }

  async function deleteSettlement(settlement) {
    const label = settlementDirectionLabels[settlement.direction] || "入出金";
    if (!confirm(`${formatDateShort(settlement.settlementDate)}の${label}を削除しますか？`)) return;
    try {
      await api(`/settlements/${settlement.id}`, { method: "DELETE", body: {} });
      await loadSummary();
      renderSettlements();
    } catch (error) {
      alert(error.message);
    }
  }

  async function openLogs() {
    el["logs-dialog"].showModal();
    await loadLogs();
  }

  async function loadLogs() {
    el["logs-body"].innerHTML = `<tr><td colspan="4">読み込み中…</td></tr>`;
    const accountId = el["logs-account-filter"].value;
    try {
      const query = new URLSearchParams({ limit: "100" });
      if (accountId) query.set("accountId", accountId);
      const result = await api(`/audit-logs?${query}`);
      el["logs-body"].innerHTML = result.logs.map((log) => `<tr>
        <td>${escapeHtml(formatTimestampJp(log.occurredAt))}</td>
        <td>${escapeHtml(eventLabel(log.eventType))}</td>
        <td>${escapeHtml(log.actorName || log.attemptedLoginId || "不明")}</td>
        <td>${escapeHtml(auditTargetLabel(log))}</td>
      </tr>`).join("") || `<tr><td colspan="4">履歴はありません。</td></tr>`;
    } catch (error) {
      el["logs-body"].innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function auditTargetLabel(log) {
    if (log.targetName) return log.targetName;
    if (log.eventType === "logout" || log.eventType.startsWith("login_")) {
      return log.actorName || log.attemptedLoginId || "不明";
    }
    return "—";
  }

  function togglePassword() {
    const showing = el["login-password"].type === "text";
    el["login-password"].type = showing ? "password" : "text";
    el["password-toggle"].setAttribute("aria-label", showing ? "パスワードを表示" : "パスワードを隠す");
    el["password-toggle"].setAttribute("aria-pressed", String(!showing));
  }

  function updateCategoryOptions(selected = "") {
    const documentType = el["entry-document-type"].value;
    const baseOptions = categoryOptions[documentType] || categoryOptions.invoice;
    const options = el["entry-record-type"].value === "entry"
      ? baseOptions.filter((value) => value !== "income")
      : baseOptions;
    el["entry-category"].replaceChildren(...options.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = categoryLabels[value];
      return option;
    }));
    el["entry-category"].value = options.includes(selected) ? selected : options[0];
    updateEntryMode();
  }

  function updateEntryMode() {
    const isSettlement = el["entry-category"].value === "income" || el["entry-record-type"].value === "settlement";
    el["entry-document-type-label"].hidden = isSettlement;
    el["entry-document-type"].required = !isSettlement;
    el["entry-description-label"].hidden = isSettlement;
    el["entry-description"].required = !isSettlement;
    el["settlement-direction-label"].hidden = !isSettlement;
    el["settlement-direction"].required = isSettlement;
    el["settlement-method-label"].hidden = !isSettlement;
    el["settlement-method"].required = isSettlement;
    el["other-direction-label"].hidden = isSettlement || el["entry-category"].value !== "other";
    const plusOption = el["other-direction"].querySelector('option[value="plus"]');
    plusOption.textContent = el["entry-document-type"].value === "invoice" ? "請求" : "支払";
  }

  function formatYenInput(input, allowNegative) {
    const normalized = normalizeNumericText(input.value);
    const negative = allowNegative && /^\s*-/.test(normalized);
    const digits = normalized.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 12);
    input.value = digits ? `${negative ? "-" : ""}${formatInteger(Number(digits))}` : (negative ? "-" : "");
  }

  function parseYenInput(value, allowNegative = false) {
    const normalized = normalizeNumericText(value).replace(/,/g, "").trim();
    if (!new RegExp(allowNegative ? "^-?\\d+$" : "^\\d+$").test(normalized)) return Number.NaN;
    const amount = Number(normalized);
    return Number.isSafeInteger(amount) ? amount : Number.NaN;
  }

  function normalizeNumericText(value) {
    return String(value)
      .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
      .replace(/，/g, ",");
  }

  function formatInteger(value) {
    return integerFormat.format(value);
  }

  function formatYen(value) {
    const amount = Number(value);
    return amount < 0 ? `△ ${formatInteger(Math.abs(amount))}円` : `${formatInteger(amount)}円`;
  }

  function renderYen(element, value) {
    element.textContent = formatYen(value);
    element.classList.toggle("negative", Number(value) < 0);
  }

  function handleDatePointerDown(event) {
    if (useMobileDateWheel()) {
      event.preventDefault();
      openDateWheel();
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
    const today = japanToday();
    if (el["entry-date"].value !== today) {
      el["entry-date"].value = today;
      el["entry-date"].dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (el["date-wheel-dialog"].open) {
      setDateDraft(today);
      renderDateWheel();
    }
  }

  function openDateWheel() {
    if (el["date-wheel-dialog"].open) return;
    setDateDraft(el["entry-date"].value || japanToday());
    renderDateWheel();
    el["date-wheel-dialog"].showModal();
  }

  function closeDateWheel() {
    if (el["date-wheel-dialog"].open) el["date-wheel-dialog"].close();
  }

  function applyDateWheel() {
    if (!state.dateDraft) return closeDateWheel();
    const nextValue = datePartsToString(state.dateDraft);
    if (el["entry-date"].value !== nextValue) {
      el["entry-date"].value = nextValue;
      el["entry-date"].dispatchEvent(new Event("input", { bubbles: true }));
    }
    closeDateWheel();
  }

  function setDateDraft(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    state.dateDraft = {
      year: clamp(year || Number(japanToday().slice(0, 4)), 1900, 2100),
      month: clamp(month || 1, 1, 12),
      day: day || 1
    };
    state.dateDraft.day = clamp(state.dateDraft.day, 1, daysInMonth(state.dateDraft.year, state.dateDraft.month));
  }

  function renderDateWheel() {
    if (!state.dateDraft) return;
    fillDateWheel(el["date-wheel-year"], range(1900, 2100), state.dateDraft.year, "年");
    fillDateWheel(el["date-wheel-month"], range(1, 12), state.dateDraft.month, "月");
    renderDayWheel();
    updateDateWheelValue();
  }

  function renderDayWheel() {
    const maximum = daysInMonth(state.dateDraft.year, state.dateDraft.month);
    state.dateDraft.day = clamp(state.dateDraft.day, 1, maximum);
    fillDateWheel(el["date-wheel-day"], range(1, maximum), state.dateDraft.day, "日");
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
    el["date-wheel-value"].textContent = `${year}年${month}月${day}日`;
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

  async function api(path, options = {}) {
    const response = await fetch(`${basePath()}/api${path}`, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== "/login") showLogin();
      throw new Error(data.error || "処理に失敗しました。");
    }
    return data;
  }

  function basePath() {
    return location.pathname.startsWith("/billing") ? "/billing" : "";
  }

  function japanToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  function formatMonthJp(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    return `${year}年${monthNumber}月`;
  }

  function formatDateJp(date) {
    const [year, month, day] = date.split("-").map(Number);
    return `${year}年${month}月${day}日`;
  }

  function formatDateShort(date) {
    const [, month, day] = date.split("-").map(Number);
    return `${month}月${day}日`;
  }

  function formatTimestampJp(value) {
    const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium" }).format(new Date(normalized));
  }

  function eventLabel(type) {
    return {
      login_success: "ログイン成功", login_failure: "ログイン失敗", login_locked: "ログインを一時停止",
      login_blocked: "停止中のログイン試行", logout: "ログアウト",
      entry_created: "明細を追加", entry_updated: "明細を編集", entry_deleted: "明細を削除",
      settlement_created: "入出金を追加", settlement_updated: "入出金を編集", settlement_deleted: "入出金を削除"
    }[type] || type;
  }

  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = String(value ?? "");
    return span.innerHTML;
  }
})();

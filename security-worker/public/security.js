(() => {
  "use strict";
  const display = globalThis.TRoomSecurityDisplay;
  if (!display) throw new Error("セキュリティ画面の表示設定を読み込めませんでした。");
  const state = {
    adminPrf: null, adminCredentialId: null, selectedIdentity: null,
    pendingInviteCloud: null, pendingPrimarySetup: null, identityNames: new Map(),
    currentIdentities: [], auditIdentities: [], auditIdentitiesRequest: 0,
    auditCursor: null, auditQuery: "", auditLoading: false, auditRequest: 0, auditView: "all", services: []
  };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bind();
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const inviteToken = params.get("invite");
    if (inviteToken) {
      history.replaceState(null, "", "/security/");
      $("#invite-view").hidden = false;
      $("#invite-register").onclick = () => registerInvite(inviteToken);
      return;
    }
    await routeStatus();
  }

  function bind() {
    document.addEventListener("troom:before-auto-update", (event) => {
      if (document.querySelector("button:disabled")) event.preventDefault();
    });
    $("#bootstrap-form").addEventListener("submit", bootstrap);
    $("#admin-passkey-login").addEventListener("click", adminLogin);
    $("#admin-password-recovery").addEventListener("click", () => {
      $("#admin-login-view").hidden = true;
      $("#bootstrap-view").hidden = false;
      $("#bootstrap-view h2").textContent = "第一管理者パスキーの復旧登録";
    });
    $("#security-logout").addEventListener("click", logout);
    $("#tcloud-setup-resume").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        if (state.pendingPrimarySetup?.resumable) {
          state.pendingPrimarySetup = await TRoomPasskeys.resumeSetup();
          renderPrimarySetupNotice(state.pendingPrimarySetup);
        }
        if (state.pendingPrimarySetup?.adminKeyReady) {
          const setup = state.pendingPrimarySetup;
          const prf = await TRoomPasskeys.obtainPrf(setup.credentialId);
          if (!prf.prfOutput) throw new Error("この端末ではT-Cloudの安全な鍵準備を利用できません。");
          await prepareClientVault(setup, prf.prfOutput);
          renderPrimarySetupNotice(await TRoomPasskeys.setupStatus());
          showMessage("フォルダー利用の鍵を準備しました。ユーザー詳細でこのパスキーのT-Cloud連携を承認してください。");
          await viewIdentity(setup.identityId);
          return;
        }
        $("#tcloud-setup-form").hidden = false;
        $("#tcloud-setup-id").focus();
      } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    $("#tcloud-setup-continue").addEventListener("click", () => {
      showPanel("dashboard-panel", document.querySelector('[data-panel="dashboard-panel"]'));
      $("#dashboard-panel").scrollIntoView({ block: "start" });
    });
    $("#tcloud-setup-form").addEventListener("submit", resumePrimaryAdminSetup);
    $("#invite-form").addEventListener("submit", createInvite);
    $("#add-link").addEventListener("click", () => addLinkRow());
    $("#invite-expiry").addEventListener("change", () => { $("#custom-expiry-row").hidden = $("#invite-expiry").value !== "custom"; });
    $("#audit-filter").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.submitter;
      if (button) button.disabled = true;
      try { await loadAudit({ append: false }); } catch (error) { showMessage(error.message, true); }
      finally { if (button) button.disabled = false; }
    });
    $("#audit-load-more").addEventListener("click", () => loadAudit({ append: true }).catch((error) => showMessage(error.message, true)));
    document.querySelectorAll("[data-audit-view]").forEach((button) => button.addEventListener("click", () => {
      state.auditView = button.dataset.auditView;
      document.querySelectorAll("[data-audit-view]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      const notes = {
        all: "すべての監査履歴を表示します。",
        password: "実際のID・パスワード認証と第一管理者の本人確認を表示します。保存済みセッションへのアクセスは含みません。",
        passkey: "パスキーの本人確認とログイン結果を表示します。認証開始・登録・キャンセルは含みません。本人確認とサービスへのログインは別の履歴です。",
        attention: "ログイン・本人確認の失敗や一時停止を表示します。"
      };
      $("#audit-view-note").textContent = `${notes[state.auditView]} 日時は日本時間です。各履歴を開くと詳細を確認できます。`;
      loadAudit().catch((error) => showMessage(error.message, true));
    }));
    $("#audit-filter-clear").addEventListener("click", () => {
      $("#audit-filter").reset();
      state.auditIdentitiesRequest++;
      state.auditIdentities = [];
      populateAuditIdentityFilter(state.currentIdentities);
      loadAudit().catch((error) => showMessage(error.message, true));
    });
    $("#audit-include-disabled").addEventListener("change", async () => {
      const requestId = ++state.auditIdentitiesRequest;
      const selected = $("#audit-identity").value;
      if (!$("#audit-include-disabled").checked) {
        const appliedIdentity = new URLSearchParams(state.auditQuery).get("identityId");
        const disabledFilterApplied = state.auditIdentities.some((identity) => identity.id === appliedIdentity);
        state.auditIdentities = [];
        populateAuditIdentityFilter(state.currentIdentities);
        if (disabledFilterApplied || (selected && !$("#audit-identity").value)) await loadAudit();
        return;
      }
      try {
        const data = await get("/identities?includeDisabled=true");
        if (requestId !== state.auditIdentitiesRequest || !$("#audit-include-disabled").checked) return;
        state.auditIdentities = Array.isArray(data.auditIdentities) ? data.auditIdentities : [];
        populateAuditIdentityFilter([...state.currentIdentities, ...state.auditIdentities]);
      } catch (error) {
        if (requestId !== state.auditIdentitiesRequest) return;
        $("#audit-include-disabled").checked = false;
        showMessage(error.message, true);
      }
    });
    $("#audit-refresh").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await loadAudit({ append: false }); } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => {
      showPanel(button.dataset.panel, button);
      if (button.dataset.panel === "audit-panel") loadAudit({ append: false }).catch((error) => showMessage(error.message, true));
      if (button.dataset.panel === "ai-panel") loadAiBudgets().catch((error) => showMessage(error.message, true));
    }));
    populateAuditEventFilter();
  }

  async function routeStatus() {
    try {
      const setup = await TRoomPasskeys.setupStatus();
      if ((setup.active || setup.resumable || setup.needsTCloudSetup) && !setup.isPrimaryAdmin) {
        $("#invite-view").hidden = false;
        if (setup.tcloudReady) {
          $("#invite-register").hidden = true;
          showMessage("パスキー登録とT-Cloudの準備は完了しています。管理者の承認をお待ちください。", false);
        } else if (!setup.prfEnabled) {
          $("#invite-register").hidden = true;
          showMessage("パスキー登録は完了しています。日記・請求書では承認後に利用できます。この端末ではT-Cloudのパスキー利用に対応していないため、T-Cloudは従来のID・パスワードをご利用ください。", false);
        } else {
          state.pendingInviteCloud = setup;
          $("#invite-register").textContent = "T-Cloudの準備を再開";
          $("#invite-register").onclick = () => retryInviteCloud();
        }
        return;
      }
      const status = await get("/status");
      if (!status.enabled) return showMessage("パスキー機能は現在停止中です。各サービスのID・パスワードをご利用ください。", true);
      if (!status.initialized) $("#bootstrap-view").hidden = false;
      else if (status.adminAuthenticated) await showAdmin(setup);
      else $("#admin-login-view").hidden = false;
    } catch (error) { showMessage(error.message, true); }
  }

  async function bootstrap(event) {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const loginId = $("#bootstrap-id").value.trim().toLowerCase();
      const password = $("#bootstrap-password").value;
      const mode = await cloudApi("/auth-mode");
      const credentials = await TRoomCrypto.deriveAccountCredentials(password, loginId, mode.credentialSalt);
      const result = await TRoomPasskeys.bootstrap({ loginId, authProof: credentials.authProof });
      state.adminPrf = result.prfOutput;
      state.adminCredentialId = result.credentialId;
      $("#bootstrap-password").value = "";
      $("#bootstrap-view").hidden = true;
      let tcloudReady = false;
      try {
        if (!result.prfOutput) throw new Error(result.prfPreparationFailed
          || result.prfEnabled
          ? "T-Cloudのパスキー利用準備を一時的に完了できませんでした。"
          : "この端末ではT-Cloudのパスキー利用に対応していません。");
        await preparePrimaryAdminCloud(credentials.accountKey, result.prfOutput);
        tcloudReady = true;
      } catch (preparationError) {
        const setup = await TRoomPasskeys.setupStatus().catch(() => ({
          active: true, isPrimaryAdmin: true, credentialId: result.credentialId,
          prfEnabled: Boolean(result.prfEnabled), tcloudReady: false
        }));
        const preparationMessage = TRoomPasskeys.userMessage(preparationError, {}, "T-Cloudのパスキー利用準備を一時的に完了できませんでした。");
        showMessage(`セキュリティセンター・日記・請求書のパスキー登録は完了しました。T-Cloudは未準備のため現在の管理者パスワードをご利用ください。${preparationMessage}`, false);
        await showAdmin(setup);
      }
      if (tcloudReady) {
        showMessage("第一管理者の端末ロック解除を登録しました。現在の管理者パスワードは復旧手段として維持されています。");
        await showAdmin();
      }
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function resumePrimaryAdminSetup(event) {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const setup = await TRoomPasskeys.setupStatus();
      if (!setup.active || !setup.isPrimaryAdmin || setup.tcloudReady) throw new Error("T-Cloudの準備状態が変わりました。画面を再読み込みしてください。");
      if (!setup.prfEnabled) throw new Error("この端末ではT-Cloudのパスキー利用に対応していません。T-Cloudは現在のID・パスワードをご利用ください。");
      const loginId = $("#tcloud-setup-id").value.trim().toLowerCase();
      const password = $("#tcloud-setup-password").value;
      const mode = await cloudApi("/auth-mode");
      const credentials = await TRoomCrypto.deriveAccountCredentials(password, loginId, mode.credentialSalt);
      await post("/setup/primary-admin/verify-password", { loginId, authProof: credentials.authProof });
      const prf = await TRoomPasskeys.obtainPrf(setup.credentialId);
      if (!prf.prfOutput) throw new Error("この端末ではT-Cloudのパスキー利用準備を再開できません。現在の管理者パスワードをご利用ください。");
      state.adminPrf = prf.prfOutput;
      state.adminCredentialId = setup.credentialId;
      await preparePrimaryAdminCloud(credentials.accountKey, prf.prfOutput);
      $("#tcloud-setup-password").value = "";
      $("#tcloud-setup-form").hidden = true;
      state.pendingPrimarySetup = null;
      showMessage("同じパスキーでT-Cloudの利用準備を完了しました。現在の管理者パスワードは復旧手段として維持されています。");
      renderPrimarySetupNotice(await TRoomPasskeys.setupStatus());
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function preparePrimaryAdminCloud(accountKey, prfOutput) {
    const [config, detail] = await Promise.all([get("/tcloud/admin-config"), get("/identities/primary-admin")]);
    if (!config.initialized) throw new Error("T-Cloudの暗号化設定を確認できません。");
    const link = detail.links.find((item) => item.service === "cloud" && item.service_account_id === "admin");
    if (!link) throw new Error("T-Cloud管理者連携を確認できません。");
    const envelope = await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey, config, prfOutput);
    await post("/tcloud/envelope", { serviceLinkId: link.id, envelopeType: "admin_private_prf", ...envelope });
    const setup = await TRoomPasskeys.setupStatus();
    if (!setup.clientKeyReady && setup.cloudLinks?.some((item) => item.accountId === "folder-member")) await prepareClientVault(setup, prfOutput);
  }

  async function adminLogin(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await TRoomPasskeys.authenticate("security");
      state.adminPrf = result.prfOutput;
      state.adminCredentialId = result.credentialId;
      $("#admin-login-view").hidden = true;
      await showAdmin();
    } catch (error) { showMessage(error.message, error.name !== "PasskeyCancelledError"); }
    finally { button.disabled = false; }
  }

  async function registerInvite(token) {
    const button = $("#invite-register");
    button.disabled = true;
    try {
      const result = await TRoomPasskeys.registerInvite(token);
      if (result.cloudLinks?.length) {
        const prepared = await prepareInviteCloud(result);
        if (!prepared) return;
      }
      button.hidden = true;
      showMessage("登録が完了しました。管理者の承認をお待ちください。");
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function prepareInviteCloud(result) {
    const button = $("#invite-register");
    try {
      const setup = await TRoomPasskeys.setupStatus();
      if (setup.tcloudReady) return true;
      let prfOutput = result.prfOutput;
      if (!prfOutput && result.credentialId && (result.prfPreparationFailed || result.prfEnabled)) {
        const retried = await TRoomPasskeys.obtainPrf(result.credentialId);
        prfOutput = retried.prfOutput;
        result.prfPreparationFailed = false;
      }
      if (!prfOutput) {
        if (result.prfEnabled) {
          state.pendingInviteCloud = result;
          button.hidden = false;
          button.textContent = "T-Cloudの準備を再試行";
          button.onclick = () => retryInviteCloud();
          showMessage("パスキー登録は完了しました。今回はPRF結果を取得できなかったため、T-Cloudの準備だけ完了していません。日記・請求書は承認後に利用できます。", true);
          return false;
        }
        button.hidden = true;
        showMessage("パスキー登録は完了しました。日記・請求書では承認後に利用できます。この端末ではT-Cloudのパスキー利用に対応していないため、T-Cloudは従来のID・パスワードをご利用ください。");
        return false;
      }
      await prepareClientVault(setup, prfOutput);
      state.pendingInviteCloud = null;
      return true;
    } catch (error) {
      state.pendingInviteCloud = result;
      button.hidden = false;
      button.textContent = "T-Cloudの準備を再試行";
      button.onclick = () => retryInviteCloud();
      const preparationMessage = TRoomPasskeys.userMessage(error, {}, "T-Cloudのパスキー利用準備を一時的に完了できませんでした。");
      showMessage(`パスキー登録は完了しました。T-Cloudの準備だけ完了していません。再試行してください。${preparationMessage}`, true);
      return false;
    }
  }

  async function retryInviteCloud() {
    const button = $("#invite-register");
    if (!state.pendingInviteCloud) return;
    button.disabled = true;
    try {
      let setup = await TRoomPasskeys.setupStatus();
      if (!setup.active && setup.resumable) setup = await TRoomPasskeys.resumeSetup();
      state.pendingInviteCloud = { ...state.pendingInviteCloud, ...setup, cloudLinks: setup.cloudLinks || state.pendingInviteCloud.cloudLinks };
      if (await prepareInviteCloud(state.pendingInviteCloud)) {
        button.hidden = true;
        showMessage("T-Cloudの準備が完了しました。管理者の承認をお待ちください。");
      }
    } finally {
      button.disabled = false;
    }
  }

  async function prepareClientVault(setup, prfOutput) {
    // One immutable RSA vault per credential, shared by all of its member links.
    if (setup.clientKeyReady || setup.clientKeyFingerprint) return;
    const link = (setup.cloudLinks || []).find((item) => item.accountId === "folder-member");
    if (!link) throw new Error("フォルダー利用の連携を確認してください。");
    const vault = await TRoomCrypto.createPasskeyClientVault(prfOutput);
    await post("/tcloud/envelope", { serviceLinkId: link.id, envelopeType: "client_private_prf", publicKeyJwk: vault.publicKeyJwk, encryptedPayload: vault.encryptedPayload, payloadIv: vault.payloadIv });
  }

  async function showAdmin(setup = null) {
    $("#bootstrap-view").hidden = true;
    $("#admin-login-view").hidden = true;
    $("#admin-view").hidden = false;
    const setupResult = setup || await TRoomPasskeys.setupStatus().catch(() => ({ active: false }));
    renderPrimarySetupNotice(setupResult);
    await loadServices();
    if (!$("#link-rows .link-row")) addLinkRow();
    await Promise.all([loadDashboard(), loadIdentities()]);
    await loadAudit({ append: false });
  }

  async function loadServices() {
    const data = await get("/services");
    state.services = Array.isArray(data.services) ? data.services : [];
    if (!state.services.length) throw new Error("サービス連携候補を取得できません。");
  }

  function renderPrimarySetupNotice(setup) {
    const notice = $("#tcloud-setup-notice");
    const pending = Boolean((setup?.active || setup?.resumable) && setup.isPrimaryAdmin && !setup.tcloudReady);
    state.pendingPrimarySetup = pending ? setup : null;
    notice.hidden = !pending;
    $("#tcloud-setup-form").hidden = true;
    if (!pending) return;
    const unsupported = !setup.prfEnabled;
    $("#tcloud-setup-status").textContent = unsupported
      ? "この端末ではT-Cloudのパスキー利用に対応していません。T-CloudはID・パスワードをご利用ください。セキュリティセンター・日記・請求書のパスキーはそのまま利用できます。"
      : "T-Cloudのパスキー利用準備が完了していません。T-Cloudでは現在のID・パスワードをご利用ください。セキュリティセンターの管理機能は通常どおり利用できます。";
    $("#tcloud-setup-resume").hidden = unsupported;
  }

  async function loadDashboard() {
    const data = await get("/dashboard");
    const labels = [["loginSuccess", "今日のログイン成功"], ["loginFailure", "今日のログイン失敗"], ["sessionResume", "セッション再開"], ["lockouts", "ロックアウト"], ["invited", "招待中"], ["pendingApproval", "承認待ち"], ["noPasskey", "パスキー未設定"], ["critical", "重大イベント"]];
    const activeUsers = (data.activeUsers || []).map((user) => `<div class="active-user-row"><strong>${escapeHtml(display.identityLabel(user.identityId, user.displayName))}</strong><span>${user.services.map((service) => escapeHtml(display.serviceLabel(service))).join(" / ")}</span></div>`).join("");
    const definitions = data.clamavDefinitions || { issues: ["unknown"], result: "unknown" };
    const definitionLabels = { deployment_unknown: "本番imageとの一致を確認できません", unknown: "状態を取得できません", expired: "定義が期限切れです（取得停止）", expiring: "定義が生成から5日以上経過しています", not_configured: "自動更新の設定・初回実行が未完了です", updater_stopped: "更新処理の実行を36時間以上確認できません", update_failed: "更新失敗が継続しています", update_interrupted: "更新処理が中断しています", monitor_stopped: "毎時定義監視が未確認、または完了を3時間以上確認できません" };
    const definitionTime = value => value ? new Date(value * 1000).toLocaleString("ja-JP") : "未確認";
    const definitionResults = { success: "更新・本番反映確認済み", failed: "更新失敗（本番反映状態を要確認）", running: "更新中", unknown: "未確認", deferred: "処理中ジョブのため延期" };
    const definitionPanel = `<section class="card compact" id="clamav-definitions"><h3>DownloaderのClamAV定義</h3><p>${escapeHtml((definitions.issues || ["unknown"]).map(key => definitionLabels[key] || "未確認").join(" / ") || "確認済み定義は有効です")}</p><dl>${[["定義の生成日時", definitions.generatedAt],["有効期限（7日）", definitions.expiresAt],["最終更新確認", definitions.verifiedAt],["更新処理の最終実行", definitions.lastAttemptAt],["毎時監視の最終起動", definitions.hourlyMonitorStartedAt],["毎時監視の最終完了", definitions.hourlyMonitorCheckedAt],["定義状態の最終確認（日次含む）", definitions.monitorCheckedAt],["状態の最終変化", definitions.incidentChangedAt]].map(([label,value])=>`<dt>${label}</dt><dd>${escapeHtml(definitionTime(value))}</dd>`).join("")}</dl><p>更新結果: ${escapeHtml(definitionResults[definitions.result] || "未確認")} / 連続失敗 ${Number(definitions.failures || 0)}回</p><p>署名を検証した本番imageの記録です。実際の取得時にも定義を検証します。通知はGitHubの定義監視Issueを確認してください。</p></section>`;
    $("#dashboard-panel").innerHTML = `<div class="section-heading"><h2>セキュリティ概要</h2><p>本日の認証状況と、対応が必要な項目を確認できます。</p></div><div class="stats">${labels.map(([key, label]) => `<div class="stat"><span>${label}</span><strong>${Number(data[key] || 0)}</strong></div>`).join("")}</div><section class="card compact active-users"><h3>現在ログイン中のユーザー</h3>${activeUsers || "<p>現在ログイン中のユーザーはいません。</p>"}</section>${definitionPanel}`;
  }

  async function loadAiBudgets() {
    const data = await get("/ai/budgets");
    const container = $("#ai-budget-list");
    container.innerHTML = (data.policies || []).map((policy) => {
      const usage = policy.usage || {};
      const spent = Number(usage.totalCostJpy || 0);
      const stop = Number(policy.reserveEnabled ? policy.hardStopJpy : policy.softStopJpy);
      const remaining = Math.max(0, stop - spent);
      return `<form class="card compact ai-budget-card" data-ai-budget="${escapeHtml(policy.identityId)}">
        <div class="section-heading"><h3>${escapeHtml(policy.displayName)}</h3><p>${escapeHtml(usage.period || "当月")} 利用額 ${spent.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円 / 残り安全枠 ${remaining.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円</p></div>
        <div class="stats"><div class="stat"><span>input token</span><strong>${Number(usage.inputTokens || 0).toLocaleString()}</strong></div><div class="stat"><span>output token</span><strong>${Number(usage.outputTokens || 0).toLocaleString()}</strong></div><div class="stat"><span>cached token</span><strong>${Number(usage.cachedInputTokens || 0).toLocaleString()}</strong></div><div class="stat"><span>audio token</span><strong>${(Number(usage.audioInputTokens || 0) + Number(usage.audioOutputTokens || 0)).toLocaleString()}</strong></div></div>
        <div class="budget-fields"><label>月額上限<input name="monthlyBudgetJpy" type="number" min="100" max="1000000" value="${Number(policy.monthlyBudgetJpy)}" required></label><label>通常安全停止<input name="softStopJpy" type="number" min="1" value="${Number(policy.softStopJpy)}" required></label><label>最終安全停止<input name="hardStopJpy" type="number" min="1" value="${Number(policy.hardStopJpy)}" required></label><label class="checkbox-row"><input name="reserveEnabled" type="checkbox" ${policy.reserveEnabled ? "checked" : ""}> 今月の予備枠を有効にする</label></div>
        <p class="hint">予算変更・予備枠の解放はこのSecurity Centerだけで行えます。</p><button>安全設定を保存</button>
      </form>`;
    }).join("") || "<p>AI Chatの予算設定はありません。</p>";
    container.querySelectorAll("[data-ai-budget]").forEach((form) => form.addEventListener("submit", saveAiBudget));
  }

  async function saveAiBudget(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter || form.querySelector("button");
    button.disabled = true;
    try {
      await post(`/ai/budgets/${encodeURIComponent(form.dataset.aiBudget)}`, {
        monthlyBudgetJpy: Number(form.elements.monthlyBudgetJpy.value),
        softStopJpy: Number(form.elements.softStopJpy.value),
        hardStopJpy: Number(form.elements.hardStopJpy.value),
        reserveEnabled: form.elements.reserveEnabled.checked
      });
      showMessage("AI Chatの安全設定を更新しました。", false);
      await loadAiBudgets();
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function loadIdentities() {
    const data = await get("/identities");
    const currentIdentities = (Array.isArray(data.identities) ? data.identities : []).filter((identity) => identity.status !== "disabled");
    const pendingIdentities = (Array.isArray(data.pendingIdentities) ? data.pendingIdentities : []).filter((identity) => identity.status !== "disabled");
    state.currentIdentities = [...currentIdentities, ...pendingIdentities];
    state.identityNames = new Map(state.currentIdentities.map((identity) => [identity.id, identity.displayName]));
    populateAuditIdentityFilter([...state.currentIdentities, ...state.auditIdentities]);
    const identityRow = (identity) => `<div class="identity-row"><button data-view-identity="${escapeHtml(identity.id)}">詳細</button><strong>${escapeHtml(identity.displayName)}</strong><div class="status-${escapeHtml(identity.status)}">${escapeHtml(display.identityStatusLabel(identity.status))}・パスキー ${identity.activeCredentials}件${identity.pendingCredentials ? `・承認待ち ${identity.pendingCredentials}件` : ""}</div><small>${identity.lastLoginAt ? `最終認証 ${escapeHtml(formatDate(identity.lastLoginAt))}` : "認証履歴なし"}${identity.lastSeenAt ? ` / 最終アクセス ${escapeHtml(formatDate(identity.lastSeenAt))}` : ""}</small></div>`;
    const registered = currentIdentities.map(identityRow).join("") || "<p>登録済みユーザーはいません。</p>";
    const pending = pendingIdentities.map(identityRow).join("");
    $("#identity-list").innerHTML = `<h3>登録済みユーザー</h3>${registered}${pending ? `<section class="pending-identities"><h3>招待・承認待ち</h3>${pending}</section>` : ""}`;
    document.querySelectorAll("[data-view-identity]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await viewIdentity(button.dataset.viewIdentity); } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    }));
  }

  async function viewIdentity(id) {
    const data = await get(`/identities/${encodeURIComponent(id)}`);
    state.selectedIdentity = data;
    const currentCredentials = data.credentials.filter((item) => ["pending", "active"].includes(item.status));
    const credentialHistory = data.credentials.filter((item) => !["pending", "active"].includes(item.status));
    const credentialRow = (item, historical = false) => `<div class="credential"><strong>${escapeHtml(item.label)}</strong>・${escapeHtml(statusLabel(item.status))}<br><small>登録 ${escapeHtml(formatDate(item.registered_at))} / 最終利用 ${escapeHtml(formatDate(item.last_used_at))} / ${escapeHtml(item.device_type || "端末種別不明")} / ${item.backed_up ? "複数端末で利用可能" : "この端末に保存"} / T-Cloudのパスキー利用: ${item.prf_enabled ? "対応" : "この端末では非対応"}</small>${historical ? "" : `<button class="danger" data-revoke-credential="${escapeHtml(item.credential_id)}">無効化</button>`}</div>`;
    const credentials = currentCredentials.map((item) => credentialRow(item)).join("");
    const hasCredential = currentCredentials.length > 0;
    const currentLinks = data.links.filter((item) => ["pending", "active"].includes(item.status));
    const linkHistory = data.links.filter((item) => !["pending", "active"].includes(item.status));
    const linkRow = (item, historical = false) => `<div class="link detail-item"><strong>${escapeHtml(item.account_display_name || item.display_label)}</strong>${item.service === "cloud" && item.service_account_id === "folder-member" && item.account_display_name ? `<small> / ${escapeHtml(item.display_label)}</small>` : ""}${item.folderUnavailable ? '<span class="warning-text">（連携先を取得できません）</span>' : ""}<br><small>${escapeHtml(display.serviceLabel(item.service))} / ${escapeHtml(item.role_label || display.roleLabel(item.role))} / ${escapeHtml(display.serviceLinkStatusLabel(item.status, { identityStatus: data.identity.status, service: item.service, hasCredential }))}</small>${historical ? "" : item.protected ? '<span class="protected-link">基幹連携</span>' : `<button class="danger" data-remove-link="${escapeHtml(item.id)}">連携解除</button>`}</div>`;
    const links = currentLinks.map((item) => linkRow(item)).join("");
    const invitationRows = data.invitations.map((item) => ({ ...item, effectiveStatus: display.invitationEffectiveStatus(item) }))
      .sort((left, right) => Number(right.effectiveStatus === "active") - Number(left.effectiveStatus === "active"));
    const currentInvitations = invitationRows.filter((item) => item.effectiveStatus === "active");
    const invitationHistory = invitationRows.filter((item) => item.effectiveStatus !== "active");
    const invitationRow = (item, historical = false) => `<div class="invitation detail-item"><small>${escapeHtml(formatDate(item.created_at))} / ${escapeHtml(display.invitationStatusLabel(item.effectiveStatus))} / 期限 ${escapeHtml(display.formatInvitationExpiry(item.expires_at))}</small>${historical ? "" : `<button class="danger" data-revoke-invitation="${escapeHtml(item.id)}">招待取消</button>`}</div>`;
    const invitations = currentInvitations.map((item) => invitationRow(item)).join("");
    const historyRows = [
      ...credentialHistory.map((item) => credentialRow(item, true)),
      ...linkHistory.map((item) => linkRow(item, true)),
      ...invitationHistory.map((item) => invitationRow(item, true))
    ].join("");
    const loginStates = (data.sessions || []).map((item) => {
      const latest = item.sessions?.[0];
      const stateLabel = item.available === false ? "状態を確認できません" : item.loggedIn ? "ログイン中" : "未ログイン";
      return `<div class="session-status ${item.loggedIn ? "session-active" : ""}"><div><strong>${escapeHtml(display.serviceLabel(item.service))}</strong><span>${escapeHtml(stateLabel)}</span></div>${latest ? `<small>ログイン開始 ${escapeHtml(latest.startedAt ? formatDate(latest.startedAt) : "不明")}<br>最終アクセス ${escapeHtml(formatDate(latest.lastSeenAt))}<br>有効期限 ${escapeHtml(formatDate(latest.expiresAt))}</small>` : ""}</div>`;
    }).join("");
    const approvals = (data.approvalCandidates || []).map((item) => {
      const cloudStatus = !item.hasCloudLinks ? ""
        : item.cloudClientReady
          ? `（T-Cloud ${Number(item.cloudReadyCount || 0)}件準備済み・${Number(item.cloudPendingCount || 0)}件鍵委譲待ち）`
          : item.prfEnabled ? "（T-Cloudの端末準備が未完了）" : "（この端末ではT-Cloudのパスキー利用に非対応）";
      return `<button data-approve-credential="${escapeHtml(item.credentialId)}">${escapeHtml(formatDate(item.registeredAt))}の登録を承認${cloudStatus}</button>`;
    }).join("");
    $("#identity-detail").innerHTML = `
      <section class="detail-section detail-summary"><h2>${escapeHtml(data.identity.displayName)}</h2><p class="status-${escapeHtml(data.identity.status)}">${escapeHtml(display.identityStatusLabel(data.identity.status))}</p><small>${data.identity.lastLoginAt ? `最終認証 ${escapeHtml(formatDate(data.identity.lastLoginAt))}` : "認証履歴なし"}${data.identity.lastSeenAt ? ` / 最終アクセス ${escapeHtml(formatDate(data.identity.lastSeenAt))}` : ""}</small></section>
      <section class="detail-section"><h3>現在のログイン状況</h3><div class="session-status-grid">${loginStates}</div></section>
      <section class="detail-section"><h3>サービス連携</h3>${links || "<p>サービス連携はありません。</p>"}<button id="detail-open-link" type="button" class="secondary">＋ サービス連携を追加</button><div id="detail-link-editor" class="detail-editor" hidden><div id="detail-link-row"></div><p id="detail-link-empty" class="muted" hidden>追加できるサービス連携はありません</p><div class="editor-actions"><button id="detail-add-link" type="button">追加</button><button id="detail-cancel-link" type="button" class="secondary">キャンセル</button></div></div><p class="hint">日記・請求書は管理者確認後すぐ利用できます。T-Cloudは安全な鍵委譲が完了するまで承認待ちになります。</p></section>
      <section class="detail-section"><h3>パスキー</h3>${credentials || "<p>まだパスキーは登録されていません</p>"}</section>
      <section class="detail-section"><h3>招待</h3>${invitations || "<p>有効な招待はありません。</p>"}</section>
      ${historyRows ? `<section class="detail-section"><details class="identity-history"><summary>過去の履歴を表示</summary><div class="identity-history-rows">${historyRows}</div></details></section>` : ""}
      <section class="detail-section"><h3>管理操作</h3><div class="tabs"><button id="reinvite-button" type="button">再招待</button>${approvals}${data.identity.isSecurityAdmin ? "" : '<button id="disable-identity-button" type="button" class="danger">ユーザーを停止</button>'}</div><div id="reinvite-editor" class="detail-editor" hidden><label>有効期限<select id="reinvite-expiry"><option value="3600">1時間</option><option value="21600">6時間</option><option value="86400" selected>24時間</option><option value="259200">3日</option><option value="604800">7日</option><option value="custom">日時指定</option></select></label><label id="reinvite-custom-row" hidden>日時<input id="reinvite-expiry-custom" type="datetime-local"></label><div class="editor-actions"><button id="reinvite-submit" type="button">招待URLを再発行</button><button id="reinvite-cancel" type="button" class="secondary">キャンセル</button></div></div><output id="detail-result" class="invite-result" hidden></output></section>`;
    $("#identity-detail").hidden = false;
    $("#reinvite-button").onclick = () => toggleReinviteEditor(true);
    $("#reinvite-cancel").onclick = () => toggleReinviteEditor(false);
    $("#reinvite-expiry").onchange = () => { $("#reinvite-custom-row").hidden = $("#reinvite-expiry").value !== "custom"; };
    $("#reinvite-submit").onclick = (event) => reinvite(id, event.currentTarget);
    document.querySelectorAll("[data-approve-credential]").forEach((button) => button.addEventListener("click", (event) => approve(id, event.currentTarget, button.dataset.approveCredential)));
    document.querySelectorAll("[data-revoke-credential]").forEach((button) => button.addEventListener("click", () => revokeCredential(button.dataset.revokeCredential, button)));
    document.querySelectorAll("[data-revoke-invitation]").forEach((button) => button.addEventListener("click", () => revokeInvitation(button.dataset.revokeInvitation, button)));
    document.querySelectorAll("[data-remove-link]").forEach((button) => button.addEventListener("click", () => removeLink(button.dataset.removeLink, button)));
    if ($("#disable-identity-button")) $("#disable-identity-button").onclick = (event) => disableIdentity(id, event.currentTarget);
    $("#detail-open-link").onclick = () => openDetailLinkEditor();
    $("#detail-cancel-link").onclick = () => closeDetailLinkEditor();
    $("#detail-add-link").onclick = (event) => addDetailLink(id, event.currentTarget);
  }

  function toggleReinviteEditor(open) {
    $("#reinvite-editor").hidden = !open;
    $("#reinvite-button").hidden = open;
    if (open) $("#reinvite-expiry").focus();
  }

  function currentServiceLinkKeys() {
    return new Set((state.selectedIdentity?.links || [])
      .filter((link) => ["pending", "active"].includes(link.status))
      .map((link) => serviceLinkKey(link.service, link.service_account_id, link.cloud_root_folder_id)));
  }

  function serviceLinkKey(service, accountId, rootFolderId) {
    return `${service}\u0000${accountId}\u0000${rootFolderId ?? ""}`;
  }

  function openDetailLinkEditor() {
    const editor = $("#detail-link-editor");
    const rowContainer = $("#detail-link-row");
    const excluded = currentServiceLinkKeys();
    editor.hidden = false;
    $("#detail-open-link").hidden = true;
    rowContainer.replaceChildren();
    const added = addLinkRow(null, "#detail-link-row", false, excluded);
    $("#detail-link-empty").hidden = added;
    $("#detail-add-link").hidden = !added;
    (rowContainer.querySelector("select") || $("#detail-cancel-link")).focus();
  }

  function closeDetailLinkEditor() {
    $("#detail-link-editor").hidden = true;
    $("#detail-link-row").replaceChildren();
    $("#detail-open-link").hidden = false;
    $("#detail-open-link").focus();
  }

  async function addDetailLink(identityId, button) {
    button.disabled = true;
    try {
      const row = $("#detail-link-row .link-row");
      const link = selectedLink(row);
      if (!link) throw new Error("追加するサービスと連携先を選択してください。");
      if (link.privileged) await freshAdminAuthentication();
      const result = await post(`/identities/${encodeURIComponent(identityId)}/links`, { links: [linkPayload(link)] });
      showMessage(result.requiresApproval ? "T-Cloud連携を追加しました。鍵委譲が完了するまで承認待ちです。" : "サービス連携を追加しました。既存のパスキーで利用できます。");
      await viewIdentity(identityId);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function removeLink(linkId, button) {
    if (!confirm("このサービス連携を解除しますか？既存サービス側のアカウントやデータは削除されません。")) return;
    button.disabled = true;
    try {
      await post(`/service-links/${encodeURIComponent(linkId)}`, {});
      showMessage("サービス連携を解除しました。");
      await viewIdentity(state.selectedIdentity.identity.id);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function approve(id, button, credentialId) {
    button.disabled = true;
    try {
      const detail = state.selectedIdentity;
      const cloudEnvelopes = [];
      const candidate = (detail.approvalCandidates || []).find((item) => item.credentialId === credentialId);
      const cloudApproval = candidate?.cloudApproval || null;
      if (cloudApproval) {
        if (!state.adminPrf || !state.adminCredentialId) {
          const auth = await TRoomPasskeys.authenticate("security");
          state.adminPrf = auth.prfOutput;
          state.adminCredentialId = auth.credentialId;
        }
        if (!state.adminPrf) throw new Error("管理者の端末ではT-Cloudのパスキー利用に対応していません。管理者パスワードで鍵の利用準備を行ってください。");
        const adminDetail = await get("/identities/primary-admin");
        const envelope = adminDetail.adminKeyEnvelopes.find((item) => item.credentialId === state.adminCredentialId);
        if (!envelope) throw new Error("この管理者パスキーではT-Cloudの利用準備が完了していません。第一管理者パスワードで復旧登録してください。");
        const privateKey = await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(state.adminPrf, envelope);
        for (const item of cloudApproval.folders) {
          if (item.folderUnavailable || !item.folder) throw new Error("T-Cloudフォルダ情報を取得できない連携があります。連携を解除するか、T-Cloud復旧後に再試行してください。");
          let folderKey;
          try { folderKey = await TRoomCrypto.unlockFolderAsAdmin(item.folder, privateKey); }
          catch { throw new Error("T-Cloudのフォルダ暗号鍵を読み込めませんでした。データを変更せず処理を中止しました。"); }
          cloudEnvelopes.push({ serviceLinkId: item.serviceLinkId, wrappedKey: await TRoomCrypto.wrapFolderKeyForIdentity(folderKey, cloudApproval.publicKeyJwk) });
        }
      }
      const approved = await post(`/identities/${encodeURIComponent(id)}/approve`, { credentialId, cloudEnvelopes });
      showMessage(approved.tcloudPasskeyReady === false
        ? "日記・請求書の利用を承認しました。T-Cloudは対応端末で再招待と鍵の利用準備が完了するまで従来のパスワードをご利用ください。"
        : "パスキー登録とサービス連携を承認しました。");
      await Promise.all([loadDashboard(), loadIdentities(), viewIdentity(id)]);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function reinvite(id, button) {
    button.disabled = true;
    try {
      const result = await post(`/identities/${encodeURIComponent(id)}/reinvite`, expiryPayload($("#reinvite-expiry"), $("#reinvite-expiry-custom")));
      renderInvitationResult($("#detail-result"), result);
      toggleReinviteEditor(false);
      showMessage("新しい招待URLを発行し、以前の未使用招待を無効化しました。");
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function disableIdentity(id, button) {
    if (!confirm("このユーザーを停止しますか？パスキー、サービス連携、招待、既存のパスキーセッションが利用できなくなります。既存サービス側のデータは削除されません。")) return;
    button.disabled = true;
    try {
      await post(`/identities/${encodeURIComponent(id)}/disable`, {});
      state.selectedIdentity = null;
      $("#identity-detail").hidden = true;
      $("#identity-detail").innerHTML = "";
      showMessage("ユーザーを停止しました。パスキーとサービス連携は利用できません。");
      await Promise.all([loadDashboard(), loadIdentities()]);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function revokeCredential(id, button) {
    if (!confirm("このパスキーを無効化しますか？既存のパスワードは影響を受けません。")) return;
    button.disabled = true;
    try {
      await post(`/credentials/${encodeURIComponent(id)}/revoke`, {});
      showMessage("パスキーを無効化しました。パスキー由来の既存セッションも次のアクセスで失効します。");
      await viewIdentity(state.selectedIdentity.identity.id);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function revokeInvitation(id, button) {
    if (!confirm("この招待を取り消しますか？")) return;
    button.disabled = true;
    try {
      const result = await post(`/invitations/${encodeURIComponent(id)}/revoke`, {});
      if (result.identityRetired) {
        state.selectedIdentity = null;
        $("#identity-detail").hidden = true;
        $("#identity-detail").innerHTML = "";
        showMessage("招待を取り消しました。未登録のユーザーを一覧から削除しました。");
        await Promise.all([loadDashboard(), loadIdentities()]);
      } else {
        showMessage("招待を取り消しました。");
        await Promise.all([loadDashboard(), loadIdentities(), viewIdentity(state.selectedIdentity.identity.id)]);
      }
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function createInvite(event) {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const links = [...$("#link-rows").querySelectorAll(".link-row")].map(selectedLink);
      if (!links.length || links.some((link) => !link)) throw new Error("利用するサービスと連携先を選択してください。");
      if (links.some((link) => link.privileged)) await freshAdminAuthentication();
      const result = await post("/identities", { displayName: $("#invite-name").value, ...inviteExpiryPayload(), links: links.map(linkPayload) });
      renderInvitationResult($("#invite-result"), result);
      await Promise.all([loadDashboard(), loadIdentities()]);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  function inviteExpiryPayload() {
    return expiryPayload($("#invite-expiry"), $("#invite-expiry-custom"));
  }

  function expiryPayload(expirySelect, customInput) {
    const value = expirySelect.value;
    if (value !== "custom") return { expiresIn: Number(value) };
    const customValue = customInput.value;
    if (!customValue) throw new Error("日時指定の有効期限を入力してください。");
    const expiresAt = Math.floor(new Date(customValue).getTime() / 1000);
    if (!Number.isFinite(expiresAt)) throw new Error("日時指定の有効期限を確認してください。");
    return { expiresAt };
  }

  function addLinkRow(service = null, containerSelector = "#link-rows", removable = true, excludedKeys = new Set()) {
    const availableServices = state.services.map((item) => ({
      ...item,
      targets: (item.targets || []).filter((target) => !excludedKeys.has(serviceLinkKey(target.service, target.accountId, target.rootFolderId)))
    })).filter((item) => item.targets.length);
    if (!availableServices.length) return false;
    const row = document.createElement("div");
    row.className = "link-row";
    const serviceSelect = document.createElement("select");
    serviceSelect.dataset.linkService = "";
    serviceSelect.setAttribute("aria-label", "サービス");
    serviceSelect.append(new Option("サービスを選択", ""), ...availableServices.map((item) => new Option(item.displayName, item.id)));
    const targetSelect = document.createElement("select");
    targetSelect.dataset.linkTarget = "";
    targetSelect.setAttribute("aria-label", "利用するアカウントまたはフォルダ");
    targetSelect.disabled = true;
    targetSelect.append(new Option("先にサービスを選択してください", ""));
    const targetHint = document.createElement("small");
    targetHint.className = "hint link-target-hint";
    targetHint.hidden = true;
    targetHint.textContent = "トップフォルダを選択してください。このフォルダを本人のパスキーで利用できるようにし、配下をすべて連携対象とします。他のT-Cloudフォルダは表示されません。";
    const updateTargets = () => {
      const selectedService = availableServices.find((item) => item.id === serviceSelect.value);
      row._targets = selectedService?.targets || [];
      targetSelect.replaceChildren(new Option(selectedService ? "連携先を選択" : "先にサービスを選択してください", ""));
      row._targets.forEach((target, index) => targetSelect.append(new Option(`${target.displayLabel}${target.roleLabel ? ` / ${target.roleLabel}` : ""}`, String(index))));
      targetSelect.disabled = !selectedService || !row._targets.length;
      targetHint.hidden = selectedService?.id !== "cloud";
    };
    serviceSelect.addEventListener("change", updateTargets);
    row.append(serviceSelect, targetSelect);
    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.setAttribute("aria-label", "連携を削除");
      remove.textContent = "×";
      remove.onclick = () => row.remove();
      row.append(remove);
    }
    row.append(targetHint);
    $(containerSelector).append(row);
    if (service) { serviceSelect.value = service; updateTargets(); }
    return true;
  }

  function selectedLink(row) {
    if (!row) return null;
    const value = row.querySelector("[data-link-target]")?.value;
    if (value == null || value === "") return null;
    const index = Number(value);
    return Number.isInteger(index) ? row._targets?.[index] || null : null;
  }

  function linkPayload(link) {
    return { service: link.service, accountId: link.accountId, rootFolderId: link.rootFolderId ?? null };
  }

  async function freshAdminAuthentication() {
    await TRoomPasskeys.authenticate("security");
  }

  async function loadAudit({ append = false } = {}) {
    if (append && (state.auditLoading || !state.auditCursor)) return;
    const requestId = ++state.auditRequest;
    state.auditLoading = true;
    $("#audit-list").setAttribute("aria-busy", "true");
    $("#audit-status").textContent = "履歴を読み込んでいます…";
    const more = $("#audit-load-more");
    more.disabled = true;
    const params = append ? new URLSearchParams(state.auditQuery) : currentAuditQuery();
    if (append) params.set("cursor", state.auditCursor);
    else {
      state.auditCursor = null;
      more.hidden = true;
      $("#audit-list").replaceChildren();
      const filterCount = [...params.keys()].filter((key) => key !== "view").length;
      $("#audit-filter-status").textContent = filterCount ? `（${filterCount}件の条件で絞り込み中）` : "";
    }
    try {
      const data = await get(`/audit?${params}`);
      if (requestId !== state.auditRequest) return;
      const html = data.events.map(renderAuditEvent).join("");
      if (append) {
        if (html) $("#audit-list").insertAdjacentHTML("beforeend", html);
      } else {
        $("#audit-list").innerHTML = html || "<p>該当する履歴はありません。</p>";
      }
      if (!append) state.auditQuery = params.toString();
      state.auditCursor = data.nextCursor || null;
      more.hidden = !state.auditCursor;
      $("#audit-status").textContent = `${$("#audit-list").querySelectorAll(".audit-row").length}件を表示${state.auditCursor ? "・続きがあります" : ""}`;
    } catch (error) {
      if (requestId !== state.auditRequest) return;
      $("#audit-status").textContent = "履歴を読み込めませんでした。「最新に更新」で再試行してください。";
    } finally {
      if (requestId === state.auditRequest) {
        state.auditLoading = false;
        more.disabled = false;
        $("#audit-list").setAttribute("aria-busy", "false");
      }
    }
  }

  function currentAuditQuery() {
    const params = new URLSearchParams();
    params.set("view", state.auditView);
    [["identityId", "#audit-identity"], ["service", "#audit-service"], ["authMethod", "#audit-auth"], ["outcome", "#audit-outcome"], ["eventType", "#audit-event"], ["from", "#audit-from"], ["to", "#audit-to"]].forEach(([key, selector]) => {
      const value = $(selector).value;
      if (value) params.set(key, value);
    });
    return params;
  }

  function populateAuditIdentityFilter(identities) {
    const select = $("#audit-identity");
    const selected = select.value;
    const unique = new Map();
    for (const identity of identities) {
      if (identity.status === "disabled" && !$("#audit-include-disabled").checked) continue;
      if (identity?.id && !unique.has(identity.id)) unique.set(identity.id, identity);
    }
    select.replaceChildren(new Option("すべて", ""));
    for (const identity of unique.values()) {
      const option = document.createElement("option");
      option.value = identity.id;
      option.textContent = `${display.identityLabel(identity.id, identity.displayName)}${identity.status === "disabled" ? "（停止済み）" : ""}`;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

  function populateAuditEventFilter() {
    const select = $("#audit-event");
    for (const group of display.eventGroups()) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const item of group.options) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        optgroup.append(option);
      }
      select.append(optgroup);
    }
  }

  function renderAuditEvent(event) {
    const identityId = String(event.identity_id || "");
    const serviceAccountId = String(event.service_account_id || "");
    const identityName = event.identity_display_name || state.identityNames.get(identityId);
    const actor = display.identityLabel(identityId, identityName, serviceAccountId, event.role);
    const outcome = String(event.outcome || "");
    const outcomeClass = ["success", "failure", "blocked", "cancelled", "info"].includes(outcome) ? outcome : "unknown";
    const userAgent = String(event.user_agent || "");
    // Password audit attribution describes a service account, not necessarily a
    // verified person. Prefer its saved label when Identity linkage is absent.
    const user = event.actor_display_name || (identityId === "primary-admin" ? "田中宏知" : identityName ? actor : event.service_account_label || actor);
    const fields = [
      ["Identity ID", identityId], ["サービス内ID", serviceAccountId],
      ["サービス内の表示名", event.account_display_name || event.service_account_label], ["role", event.role],
      ["イベントID", event.event_id], ["操作内容", event.event_type],
      ["サービス連携ID", event.service_link_id], ["セッションハッシュ", event.session_id_hash],
      ["接続元ハッシュ", event.source_hash], ["対象種別", event.target_type],
      ["対象ID", event.target_id], ["その他の監査情報", event.details_json]
    ].filter(([, value]) => value != null && value !== "");
    const method = event.auth_method === "password" ? "ID・パスワード" : display.authMethodLabel(event.auth_method);
    const date = event.occurred_at ? new Date(event.occurred_at).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    }) : "日時不明";
    return `<details class="audit-row audit-${outcomeClass}">
      <summary class="audit-summary">
        <time datetime="${escapeHtml(event.occurred_at || "")}">${escapeHtml(date)}</time>
        <strong>${escapeHtml(user)}</strong>
        <span>${escapeHtml(display.serviceLabel(event.service))}</span>
        <span>${escapeHtml(method)}</span>
        <span class="audit-chip outcome-${outcomeClass}">${escapeHtml(display.outcomeLabel(outcome))}</span>
        <span class="audit-device">${escapeHtml(display.formatUserAgent(userAgent))}</span>
        <span class="audit-operation">${escapeHtml(display.eventLabel(event.event_type))}</span>
      </summary>
      <div class="audit-detail">
        <p>${escapeHtml(event.occurred_at ? new Date(event.occurred_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "日時不明")}（日本時間）</p>
        <dl>${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}
          <div><dt>User-Agent</dt><dd>${escapeHtml(userAgent) || "記録なし"}</dd></div>
        </dl>
      </div>
    </details>`;
  }

  function renderInvitationResult(container, result) {
    const invitationUrl = absoluteInviteUrl(result.invitationUrl);
    container.hidden = false;
    container.innerHTML = `<span class="invite-result-label">招待URL</span><a href="${escapeHtml(invitationUrl)}">${escapeHtml(invitationUrl)}</a><span>有効期限: ${escapeHtml(display.formatInvitationExpiry(result.expiresAt))}</span><button type="button" class="secondary" data-copy-invite>URLをコピー</button><span class="copy-status" aria-live="polite"></span>`;
    container.querySelector("[data-copy-invite]").onclick = async (event) => {
      const button = event.currentTarget;
      const status = container.querySelector(".copy-status");
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(invitationUrl);
        status.textContent = "コピーしました";
      } catch {
        status.textContent = "コピーできませんでした。URLを選択してコピーしてください。";
      } finally {
        button.disabled = false;
      }
    };
  }

  async function logout(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try { await post("/logout", {}); location.reload(); }
    catch (error) { showMessage(error.message, true); button.disabled = false; }
  }
  function showPanel(id, button) { document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = panel.id !== id; }); document.querySelectorAll("[data-panel]").forEach((item) => item.classList.toggle("active", item === button)); }
  function showMessage(text, error = false) {
    const box = $("#message");
    box.hidden = false;
    box.classList.toggle("error", error);
    box.textContent = error ? TRoomPasskeys.safeJapaneseMessage(text) : text;
  }
  function statusLabel(value) { return display.statusLabel(value); }
  function formatDate(value) { return value ? new Date(value).toLocaleString("ja-JP") : "-"; }
  function absoluteInviteUrl(path) { return new URL(path, location.origin).href; }

  async function cloudApi(path, body) {
    const response = await fetch(`/cloud/api${path}`, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(TRoomPasskeys.safeJapaneseMessage(payload.error, "T-Cloudの管理者確認に失敗しました。"));
    return payload;
  }
  async function get(path) { return request(path); }
  async function post(path, body) { return request(path, body); }
  async function request(path, body) {
    const response = await fetch(`/security/api${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(TRoomPasskeys.safeJapaneseMessage(payload.error, "Security Centerの処理に失敗しました。"));
    return payload;
  }
})();

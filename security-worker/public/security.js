(() => {
  "use strict";
  const display = globalThis.TRoomSecurityDisplay;
  if (!display) throw new Error("セキュリティ画面の表示設定を読み込めませんでした。");
  const state = {
    adminPrf: null, adminCredentialId: null, selectedIdentity: null,
    pendingInviteCloud: null, pendingPrimarySetup: null, identityNames: new Map(),
    auditCursor: null, auditLoading: false, services: []
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
    $("#audit-refresh").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try { await loadAudit({ append: false }); } catch (error) { showMessage(error.message, true); }
      finally { event.currentTarget.disabled = false; }
    });
    document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => {
      showPanel(button.dataset.panel, button);
      if (button.dataset.panel === "audit-panel") loadAudit({ append: false }).catch((error) => showMessage(error.message, true));
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
      const vault = await TRoomCrypto.createPasskeyClientVault(prfOutput);
      const cloudLinks = result.cloudLinks || setup.cloudLinks || [];
      await post("/tcloud/envelope", { serviceLinkId: cloudLinks[0]?.id || null, envelopeType: "client_private_prf", publicKeyJwk: vault.publicKeyJwk, encryptedPayload: vault.encryptedPayload, payloadIv: vault.payloadIv });
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
    $("#dashboard-panel").innerHTML = `<div class="section-heading"><h2>セキュリティ概要</h2><p>本日の認証状況と、対応が必要な項目を確認できます。</p></div><div class="stats">${labels.map(([key, label]) => `<div class="stat"><span>${label}</span><strong>${Number(data[key] || 0)}</strong></div>`).join("")}</div>`;
  }

  async function loadIdentities() {
    const data = await get("/identities");
    state.identityNames = new Map(data.identities.map((identity) => [identity.id, identity.displayName]));
    $("#identity-list").innerHTML = data.identities.map((identity) => `<div class="identity-row"><button data-view-identity="${escapeHtml(identity.id)}">詳細</button><strong>${escapeHtml(identity.displayName)}</strong><div class="status-${escapeHtml(identity.status)}">${escapeHtml(display.identityStatusLabel(identity.status))}・パスキー ${identity.activeCredentials}件${identity.pendingCredentials ? `・承認待ち ${identity.pendingCredentials}件` : ""}</div><small>${identity.lastLoginAt ? `最終認証 ${escapeHtml(formatDate(identity.lastLoginAt))}` : "認証履歴なし"}${identity.lastSeenAt ? ` / 最終アクセス ${escapeHtml(formatDate(identity.lastSeenAt))}` : ""}</small></div>`).join("") || "<p>ユーザーはまだ登録されていません。</p>";
    document.querySelectorAll("[data-view-identity]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await viewIdentity(button.dataset.viewIdentity); } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    }));
  }

  async function viewIdentity(id) {
    const data = await get(`/identities/${encodeURIComponent(id)}`);
    state.selectedIdentity = data;
    const credentials = data.credentials.map((item) => `<div class="credential"><strong>${escapeHtml(item.label)}</strong>・${escapeHtml(statusLabel(item.status))}<br><small>登録 ${escapeHtml(formatDate(item.registered_at))} / 最終利用 ${escapeHtml(formatDate(item.last_used_at))} / ${escapeHtml(item.device_type || "端末種別不明")} / ${item.backed_up ? "複数端末で利用可能" : "この端末に保存"} / T-Cloudのパスキー利用: ${item.prf_enabled ? "対応" : "この端末では非対応"}</small>${item.status !== "revoked" ? `<button class="danger" data-revoke-credential="${escapeHtml(item.credential_id)}">無効化</button>` : ""}</div>`).join("");
    const hasCredential = data.credentials.some((item) => ["pending", "active"].includes(item.status));
    const links = data.links.map((item) => `<div class="link detail-item"><strong>${escapeHtml(item.display_label)}</strong>${item.folderUnavailable ? '<span class="warning-text">（連携先を取得できません）</span>' : ""}<br><small>${escapeHtml(display.serviceLabel(item.service))} / ${escapeHtml(item.role_label || display.roleLabel(item.role))} / ${escapeHtml(display.serviceLinkStatusLabel(item.status, { identityStatus: data.identity.status, service: item.service, hasCredential }))}</small>${item.protected ? '<span class="protected-link">基幹連携</span>' : `<button class="danger" data-remove-link="${escapeHtml(item.id)}">連携解除</button>`}</div>`).join("");
    const invitationRows = data.invitations.map((item) => ({ ...item, effectiveStatus: display.invitationEffectiveStatus(item) }))
      .sort((left, right) => Number(right.effectiveStatus === "active") - Number(left.effectiveStatus === "active"));
    const invitations = invitationRows.map((item) => `<div class="invitation detail-item"><small>${escapeHtml(formatDate(item.created_at))} / ${escapeHtml(display.invitationStatusLabel(item.effectiveStatus))} / 期限 ${escapeHtml(display.formatInvitationExpiry(item.expires_at))}</small>${item.effectiveStatus === "active" ? `<button class="danger" data-revoke-invitation="${escapeHtml(item.id)}">招待取消</button>` : ""}</div>`).join("");
    const approvals = (data.approvalCandidates || []).map((item) => {
      const cloudStatus = !item.hasCloudLinks ? ""
        : item.cloudClientReady
          ? `（T-Cloud ${Number(item.cloudReadyCount || 0)}件準備済み・${Number(item.cloudPendingCount || 0)}件鍵委譲待ち）`
          : item.prfEnabled ? "（T-Cloudの端末準備が未完了）" : "（この端末ではT-Cloudのパスキー利用に非対応）";
      return `<button data-approve-credential="${escapeHtml(item.credentialId)}">${escapeHtml(formatDate(item.registeredAt))}の登録を承認${cloudStatus}</button>`;
    }).join("");
    $("#identity-detail").innerHTML = `
      <section class="detail-section detail-summary"><h2>${escapeHtml(data.identity.displayName)}</h2><p class="status-${escapeHtml(data.identity.status)}">${escapeHtml(display.identityStatusLabel(data.identity.status))}</p><small>${data.identity.lastLoginAt ? `最終認証 ${escapeHtml(formatDate(data.identity.lastLoginAt))}` : "認証履歴なし"}${data.identity.lastSeenAt ? ` / 最終アクセス ${escapeHtml(formatDate(data.identity.lastSeenAt))}` : ""}</small></section>
      <section class="detail-section"><h3>サービス連携</h3>${links || "<p>サービス連携はありません。</p>"}<button id="detail-open-link" type="button" class="secondary">＋ サービス連携を追加</button><div id="detail-link-editor" class="detail-editor" hidden><div id="detail-link-row"></div><p id="detail-link-empty" class="muted" hidden>追加できるサービス連携はありません</p><div class="editor-actions"><button id="detail-add-link" type="button">追加</button><button id="detail-cancel-link" type="button" class="secondary">キャンセル</button></div></div><p class="hint">日記・請求書は管理者確認後すぐ利用できます。T-Cloudは安全な鍵委譲が完了するまで承認待ちになります。</p></section>
      <section class="detail-section"><h3>パスキー</h3>${credentials || "<p>まだパスキーは登録されていません</p>"}</section>
      <section class="detail-section"><h3>招待</h3>${invitations || "<p>招待履歴はありません。</p>"}</section>
      <section class="detail-section"><h3>管理操作</h3><div class="tabs"><button id="reinvite-button" type="button">再招待</button>${approvals}</div><div id="reinvite-editor" class="detail-editor" hidden><label>有効期限<select id="reinvite-expiry"><option value="3600">1時間</option><option value="21600">6時間</option><option value="86400" selected>24時間</option><option value="259200">3日</option><option value="604800">7日</option><option value="custom">日時指定</option></select></label><label id="reinvite-custom-row" hidden>日時<input id="reinvite-expiry-custom" type="datetime-local"></label><div class="editor-actions"><button id="reinvite-submit" type="button">招待URLを再発行</button><button id="reinvite-cancel" type="button" class="secondary">キャンセル</button></div></div><output id="detail-result" class="invite-result" hidden></output></section>`;
    $("#identity-detail").hidden = false;
    $("#reinvite-button").onclick = () => toggleReinviteEditor(true);
    $("#reinvite-cancel").onclick = () => toggleReinviteEditor(false);
    $("#reinvite-expiry").onchange = () => { $("#reinvite-custom-row").hidden = $("#reinvite-expiry").value !== "custom"; };
    $("#reinvite-submit").onclick = (event) => reinvite(id, event.currentTarget);
    document.querySelectorAll("[data-approve-credential]").forEach((button) => button.addEventListener("click", (event) => approve(id, event.currentTarget, button.dataset.approveCredential)));
    document.querySelectorAll("[data-revoke-credential]").forEach((button) => button.addEventListener("click", () => revokeCredential(button.dataset.revokeCredential, button)));
    document.querySelectorAll("[data-revoke-invitation]").forEach((button) => button.addEventListener("click", () => revokeInvitation(button.dataset.revokeInvitation, button)));
    document.querySelectorAll("[data-remove-link]").forEach((button) => button.addEventListener("click", () => removeLink(button.dataset.removeLink, button)));
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
          const folderKey = await TRoomCrypto.unlockFolderAsAdmin(item.folder, privateKey);
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
    if (state.auditLoading || (append && !state.auditCursor)) return;
    state.auditLoading = true;
    const more = $("#audit-load-more");
    more.disabled = true;
    const params = new URLSearchParams();
    [["service", "#audit-service"], ["authMethod", "#audit-auth"], ["outcome", "#audit-outcome"], ["eventType", "#audit-event"], ["from", "#audit-from"], ["to", "#audit-to"]].forEach(([key, selector]) => { const value = $(selector).value; if (value) params.set(key, value); });
    if (append) params.set("cursor", state.auditCursor);
    try {
      const data = await get(`/audit?${params}`);
      const html = data.events.map(renderAuditEvent).join("");
      if (append) {
        if (html) $("#audit-list").insertAdjacentHTML("beforeend", html);
      } else {
        $("#audit-list").innerHTML = html || "<p>該当する履歴はありません。</p>";
      }
      state.auditCursor = data.nextCursor || null;
      more.hidden = !state.auditCursor;
    } finally {
      state.auditLoading = false;
      more.disabled = false;
    }
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
    const actor = display.identityLabel(identityId, state.identityNames.get(identityId), serviceAccountId, event.role);
    const technicalId = identityId || serviceAccountId;
    const outcome = String(event.outcome || "");
    const outcomeClass = ["success", "failure", "blocked", "cancelled", "info"].includes(outcome) ? outcome : "unknown";
    const userAgent = String(event.user_agent || "");
    const role = event.role ? `<span class="audit-chip">${escapeHtml(display.roleLabel(event.role))}</span>` : "";
    const serviceAccount = event.service_account_label ? `<span class="audit-account">${escapeHtml(display.serviceLabel(event.service))} / ${escapeHtml(event.service_account_label)}</span>` : "";
    const technicalValues = [identityId ? `ユーザーID: ${identityId}` : "", serviceAccountId ? `サービス内ID: ${serviceAccountId}` : ""].filter(Boolean);
    const idDetail = technicalId ? `<details class="technical-detail"><summary>技術情報</summary><span>${technicalValues.map(escapeHtml).join(" / ")}</span></details>` : "";
    return `<article class="audit-row audit-${outcomeClass}">
      <div class="audit-heading"><strong>${escapeHtml(display.eventLabel(event.event_type))}</strong><time datetime="${escapeHtml(event.occurred_at || "")}">${escapeHtml(formatDate(event.occurred_at))}</time></div>
      <div class="event-meta" aria-label="操作の概要">
        <span class="audit-chip">${escapeHtml(display.serviceLabel(event.service))}</span>
        <span class="audit-chip">${escapeHtml(actor)}</span>
        ${role}
        <span class="audit-chip">${escapeHtml(display.authMethodLabel(event.auth_method))}</span>
        <span class="audit-chip outcome-${outcomeClass}">${escapeHtml(display.outcomeLabel(outcome))}</span>
      </div>
      ${serviceAccount}
      ${idDetail}
      <div class="audit-device" title="${escapeHtml(userAgent)}">利用端末: ${escapeHtml(display.formatUserAgent(userAgent))}</div>
    </article>`;
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

(() => {
  "use strict";
  const state = { adminPrf: null, adminCredentialId: null, selectedIdentity: null, pendingInviteCloud: null, pendingPrimarySetup: null };
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
    $("#tcloud-setup-resume").addEventListener("click", () => {
      $("#tcloud-setup-form").hidden = false;
      $("#tcloud-setup-id").focus();
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
      button.disabled = true;
      try { await loadAudit(); } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => showPanel(button.dataset.panel, button)));
    addLinkRow("diary", "main-admin");
  }

  async function routeStatus() {
    try {
      const setup = await TRoomPasskeys.setupStatus();
      if (setup.active && !setup.isPrimaryAdmin) {
        $("#invite-view").hidden = false;
        if (setup.tcloudReady) {
          $("#invite-register").hidden = true;
          showMessage("パスキー登録とT-Cloudの準備は完了しています。管理者の承認をお待ちください。", false);
        } else if (!setup.prfEnabled) {
          $("#invite-register").hidden = true;
          showMessage("パスキー登録は完了しています。日記・請求書では承認後に利用できます。T-Cloudはこの端末がPRF非対応のため従来のID・パスワードをご利用ください。", false);
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
          ? "T-Cloudの鍵準備を一時的に完了できませんでした。"
          : "この端末はT-Cloudの安全なパスキー復号に対応していません。");
        await preparePrimaryAdminCloud(credentials.accountKey, result.prfOutput);
        tcloudReady = true;
      } catch (preparationError) {
        const setup = await TRoomPasskeys.setupStatus().catch(() => ({
          active: true, isPrimaryAdmin: true, credentialId: result.credentialId,
          prfEnabled: Boolean(result.prfEnabled), tcloudReady: false
        }));
        showMessage(`Security Center・日記・請求書のパスキー登録は完了しました。T-Cloudは未準備のため現在の管理者PWをご利用ください。${preparationError.message || ""}`, false);
        await showAdmin(setup);
      }
      if (tcloudReady) {
        showMessage("第一管理者の端末ロック解除を登録しました。現在の管理者PWは復旧手段として維持されています。");
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
      if (!setup.prfEnabled) throw new Error("この端末ではT-Cloudのパスキー復号に対応していません。T-Cloudは現在のID・PWをご利用ください。");
      const loginId = $("#tcloud-setup-id").value.trim().toLowerCase();
      const password = $("#tcloud-setup-password").value;
      const mode = await cloudApi("/auth-mode");
      const credentials = await TRoomCrypto.deriveAccountCredentials(password, loginId, mode.credentialSalt);
      await post("/setup/primary-admin/verify-password", { loginId, authProof: credentials.authProof });
      const prf = await TRoomPasskeys.obtainPrf(setup.credentialId);
      if (!prf.prfOutput) throw new Error("この端末ではT-Cloudの安全なパスキー復号を再開できません。現在の管理者PWをご利用ください。");
      state.adminPrf = prf.prfOutput;
      state.adminCredentialId = setup.credentialId;
      await preparePrimaryAdminCloud(credentials.accountKey, prf.prfOutput);
      $("#tcloud-setup-password").value = "";
      $("#tcloud-setup-form").hidden = true;
      state.pendingPrimarySetup = null;
      showMessage("同じパスキーでT-Cloudの鍵準備を完了しました。現在の管理者PWは復旧手段として維持されています。");
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
        button.hidden = true;
        showMessage("パスキー登録は完了しました。日記・請求書では承認後に利用できます。T-Cloudはこの端末がPRF非対応のため従来のID・パスワードをご利用ください。");
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
      showMessage(`パスキー登録は完了しました。T-Cloudの準備だけ完了していません。再試行してください。${error.message || ""}`, true);
      return false;
    }
  }

  async function retryInviteCloud() {
    const button = $("#invite-register");
    if (!state.pendingInviteCloud) return;
    button.disabled = true;
    try {
      const setup = await TRoomPasskeys.setupStatus();
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
    await Promise.all([loadDashboard(), loadIdentities(), loadAudit()]);
  }

  function renderPrimarySetupNotice(setup) {
    const notice = $("#tcloud-setup-notice");
    const pending = Boolean(setup?.active && setup.isPrimaryAdmin && !setup.tcloudReady);
    state.pendingPrimarySetup = pending ? setup : null;
    notice.hidden = !pending;
    $("#tcloud-setup-form").hidden = true;
    if (!pending) return;
    const unsupported = !setup.prfEnabled;
    $("#tcloud-setup-status").textContent = unsupported
      ? "この端末ではT-Cloudのパスキー復号に対応していません。T-CloudはID・PWをご利用ください。Security Center・日記・請求書のパスキーはそのまま利用できます。"
      : "T-Cloudのパスキー利用準備が完了していません。T-Cloudでは現在のID・PWをご利用ください。Security Centerの管理機能は通常どおり利用できます。";
    $("#tcloud-setup-resume").hidden = unsupported;
  }

  async function loadDashboard() {
    const data = await get("/dashboard");
    const labels = [["loginSuccess", "今日のログイン成功"], ["loginFailure", "今日のログイン失敗"], ["lockouts", "ロックアウト"], ["invited", "招待中"], ["pendingApproval", "承認待ち"], ["noPasskey", "パスキー未設定"], ["critical", "重大イベント"]];
    $("#dashboard-panel").innerHTML = `<div class="stats">${labels.map(([key, label]) => `<div class="stat"><span>${label}</span><strong>${Number(data[key] || 0)}</strong></div>`).join("")}</div>`;
  }

  async function loadIdentities() {
    const data = await get("/identities");
    $("#identity-list").innerHTML = data.identities.map((identity) => `<div class="identity-row"><button data-view-identity="${escapeHtml(identity.id)}">詳細</button><strong>${escapeHtml(identity.displayName)}</strong><div class="status-${escapeHtml(identity.status)}">${escapeHtml(statusLabel(identity.status))}・パスキー ${identity.activeCredentials}件${identity.pendingCredentials ? `・承認待ち ${identity.pendingCredentials}件` : ""}</div><small>${identity.lastLoginAt ? `最終ログイン ${escapeHtml(formatDate(identity.lastLoginAt))}` : "ログイン履歴なし"}</small></div>`).join("") || "<p>Identityはありません。</p>";
    document.querySelectorAll("[data-view-identity]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await viewIdentity(button.dataset.viewIdentity); } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    }));
  }

  async function viewIdentity(id) {
    const data = await get(`/identities/${encodeURIComponent(id)}`);
    state.selectedIdentity = data;
    const credentials = data.credentials.map((item) => `<div class="credential"><strong>${escapeHtml(item.label)}</strong>・${escapeHtml(statusLabel(item.status))}<br><small>登録 ${escapeHtml(formatDate(item.registered_at))} / 最終利用 ${escapeHtml(formatDate(item.last_used_at))} / ${escapeHtml(item.device_type || "端末種別不明")} / ${item.backed_up ? "同期型" : "端末内"} / PRF ${item.prf_enabled ? "対応" : "未対応"}</small>${item.status !== "revoked" ? `<button class="danger" data-revoke-credential="${escapeHtml(item.credential_id)}">無効化</button>` : ""}</div>`).join("");
    const links = data.links.map((item) => `<div class="link">${escapeHtml(item.display_label)}${item.folderUnavailable ? "（フォルダ取得不能）" : ""}<br><small>${escapeHtml(item.service)} / ${escapeHtml(item.service_account_id)}${item.cloud_root_folder_id ? ` / folder #${item.cloud_root_folder_id}` : ""} / ${escapeHtml(item.status)}</small>${data.identity.id !== "primary-admin" ? `<button class="danger" data-remove-link="${escapeHtml(item.id)}">連携解除</button>` : ""}</div>`).join("");
    const invitations = data.invitations.map((item) => `<div class="invitation"><small>${escapeHtml(formatDate(item.created_at))} / ${escapeHtml(item.status)} / 期限 ${escapeHtml(new Date(Number(item.expires_at) * 1000).toLocaleString("ja-JP"))}</small>${item.status === "active" ? `<button class="danger" data-revoke-invitation="${escapeHtml(item.id)}">招待取消</button>` : ""}</div>`).join("");
    const approvals = (data.approvalCandidates || []).map((item) => {
      const cloudStatus = !item.hasCloudLinks ? ""
        : item.cloudClientReady
          ? `（T-Cloud ${Number(item.cloudReadyCount || 0)}件準備済み・${Number(item.cloudPendingCount || 0)}件鍵委譲待ち）`
          : item.prfEnabled ? "（T-Cloud端末準備未完了）" : "（T-Cloud PRF非対応）";
      return `<button data-approve-credential="${escapeHtml(item.credentialId)}">${escapeHtml(formatDate(item.registeredAt))}の登録を承認${cloudStatus}</button>`;
    }).join("");
    $("#identity-detail").innerHTML = `<h2>${escapeHtml(data.identity.displayName)}</h2><p>Identity: ${escapeHtml(data.identity.id)} / ${escapeHtml(statusLabel(data.identity.status))}</p><h3>サービス連携</h3>${links || "<p>なし</p>"}${data.identity.id !== "primary-admin" ? '<div class="link-editor"><select id="detail-link-service"><option value="diary">日記</option><option value="billing">請求書</option><option value="cloud">T-Cloud</option></select><input id="detail-link-account" placeholder="account ID"><input id="detail-link-root" type="number" min="1" placeholder="T-Cloud folder ID"><button id="detail-add-link" class="secondary">連携追加</button></div><p class="hint">追加した連携は、再招待と承認後に有効になります。</p>' : ""}<h3>登録済みパスキー</h3>${credentials || "<p>なし</p>"}<h3>招待履歴</h3>${invitations || "<p>なし</p>"}<div class="tabs"><button id="reinvite-button">再招待</button>${approvals}</div><output id="detail-result"></output>`;
    $("#identity-detail").hidden = false;
    $("#reinvite-button").onclick = (event) => reinvite(id, event.currentTarget);
    document.querySelectorAll("[data-approve-credential]").forEach((button) => button.addEventListener("click", (event) => approve(id, event.currentTarget, button.dataset.approveCredential)));
    document.querySelectorAll("[data-revoke-credential]").forEach((button) => button.addEventListener("click", () => revokeCredential(button.dataset.revokeCredential, button)));
    document.querySelectorAll("[data-revoke-invitation]").forEach((button) => button.addEventListener("click", () => revokeInvitation(button.dataset.revokeInvitation, button)));
    document.querySelectorAll("[data-remove-link]").forEach((button) => button.addEventListener("click", () => removeLink(button.dataset.removeLink, button)));
    $("#detail-add-link")?.addEventListener("click", (event) => addDetailLink(id, event.currentTarget));
  }

  async function addDetailLink(identityId, button) {
    button.disabled = true;
    try {
      const service = $("#detail-link-service").value;
      const accountId = $("#detail-link-account").value.trim();
      const rootFolderId = $("#detail-link-root").value || null;
      await post(`/identities/${encodeURIComponent(identityId)}/links`, { links: [{ service, accountId, rootFolderId }] });
      showMessage("連携を追加しました。利用開始には再招待と承認が必要です。");
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
        if (!state.adminPrf) throw new Error("管理者の端末がT-Cloudパスキー復号に対応していません。管理者PW経路で鍵委譲を準備してください。");
        const adminDetail = await get("/identities/primary-admin");
        const envelope = adminDetail.adminKeyEnvelopes.find((item) => item.credentialId === state.adminCredentialId);
        if (!envelope) throw new Error("この管理者パスキーにはT-Cloud暗号鍵が登録されていません。第一管理者PWで復旧登録してください。");
        const privateKey = await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(state.adminPrf, envelope);
        for (const item of cloudApproval.folders) {
          if (item.folderUnavailable || !item.folder) throw new Error("T-Cloudフォルダ情報を取得できない連携があります。連携を解除するか、T-Cloud復旧後に再試行してください。");
          const folderKey = await TRoomCrypto.unlockFolderAsAdmin(item.folder, privateKey);
          cloudEnvelopes.push({ serviceLinkId: item.serviceLinkId, wrappedKey: await TRoomCrypto.wrapFolderKeyForIdentity(folderKey, cloudApproval.publicKeyJwk) });
        }
      }
      const approved = await post(`/identities/${encodeURIComponent(id)}/approve`, { credentialId, cloudEnvelopes });
      showMessage(approved.tcloudPasskeyReady === false
        ? "日記・請求書の利用を承認しました。T-CloudはPRF対応端末で再招待・鍵委譲が完了するまで従来PWをご利用ください。"
        : "パスキー登録とサービス連携を承認しました。");
      await Promise.all([loadDashboard(), loadIdentities(), viewIdentity(id)]);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function reinvite(id, button) {
    button.disabled = true;
    try {
      const result = await post(`/identities/${encodeURIComponent(id)}/reinvite`, inviteExpiryPayload());
      $("#detail-result").textContent = absoluteInviteUrl(result.invitationUrl);
      showMessage("新しい招待URLを発行し、以前の未使用招待を無効化しました。");
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function revokeCredential(id, button) {
    if (!confirm("このパスキーを無効化しますか？既存PWは影響を受けません。")) return;
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
      await post(`/invitations/${encodeURIComponent(id)}/revoke`, {});
      showMessage("招待を取り消しました。");
      await viewIdentity(state.selectedIdentity.identity.id);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  async function createInvite(event) {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const links = [...document.querySelectorAll(".link-row")].map((row) => ({ service: row.querySelector("[data-link-service]").value, accountId: row.querySelector("[data-link-account]").value.trim(), rootFolderId: row.querySelector("[data-link-root]").value || null }));
      const result = await post("/identities", { displayName: $("#invite-name").value, identityId: $("#invite-identity-id").value || undefined, ...inviteExpiryPayload(), links });
      $("#invite-result").textContent = absoluteInviteUrl(result.invitationUrl);
      await Promise.all([loadDashboard(), loadIdentities()]);
    } catch (error) { showMessage(error.message, true); }
    finally { button.disabled = false; }
  }

  function inviteExpiryPayload() {
    const value = $("#invite-expiry").value;
    if (value !== "custom") return { expiresIn: Number(value) };
    const customValue = $("#invite-expiry-custom").value;
    if (!customValue) throw new Error("日時指定の有効期限を入力してください。");
    const expiresAt = Math.floor(new Date(customValue).getTime() / 1000);
    if (!Number.isFinite(expiresAt)) throw new Error("日時指定の有効期限を確認してください。");
    return { expiresAt };
  }

  function addLinkRow(service = "diary", account = "") {
    const row = document.createElement("div");
    row.className = "link-row";
    row.innerHTML = `<select data-link-service><option value="diary">日記</option><option value="billing">請求書</option><option value="cloud">T-Cloud</option></select><input data-link-account placeholder="account ID" value="${escapeHtml(account)}" required><input data-link-root type="number" min="1" placeholder="T-Cloud folder ID"><button type="button" class="secondary" aria-label="連携を削除">×</button>`;
    row.querySelector("[data-link-service]").value = service;
    row.querySelector("button").onclick = () => row.remove();
    $("#link-rows").append(row);
  }

  async function loadAudit() {
    const params = new URLSearchParams();
    [["service", "#audit-service"], ["authMethod", "#audit-auth"], ["outcome", "#audit-outcome"], ["eventType", "#audit-event"], ["from", "#audit-from"], ["to", "#audit-to"]].forEach(([key, selector]) => { const value = $(selector).value; if (value) params.set(key, value); });
    const data = await get(`/audit?${params}`);
    $("#audit-list").innerHTML = data.events.map((event) => `<article class="audit-row"><strong>${escapeHtml(event.event_type)}</strong><div class="event-meta"><span>${escapeHtml(formatDate(event.occurred_at))}</span><span>${escapeHtml(event.service)}</span><span>${escapeHtml(event.outcome)}</span><span>${escapeHtml(event.auth_method || "-")}</span><span>${escapeHtml(event.identity_id || event.service_account_id || "-")}</span><span>${escapeHtml(event.user_agent || "-")}</span></div></article>`).join("") || "<p>該当する履歴はありません。</p>";
  }

  async function logout(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try { await post("/logout", {}); location.reload(); }
    catch (error) { showMessage(error.message, true); button.disabled = false; }
  }
  function showPanel(id, button) { document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = panel.id !== id; }); document.querySelectorAll("[data-panel]").forEach((item) => item.classList.toggle("active", item === button)); }
  function showMessage(text, error = false) { const box = $("#message"); box.hidden = false; box.classList.toggle("error", error); box.textContent = text; }
  function statusLabel(value) { return ({ invited: "招待中", pending_approval: "承認待ち", active: "利用可能", disabled: "停止", pending: "承認待ち", revoked: "無効" })[value] || value; }
  function formatDate(value) { return value ? new Date(value).toLocaleString("ja-JP") : "-"; }
  function absoluteInviteUrl(path) { return new URL(path, location.origin).href; }

  async function cloudApi(path, body) {
    const response = await fetch(`/cloud/api${path}`, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "T-Cloudの管理者確認に失敗しました。");
    return payload;
  }
  async function get(path) { return request(path); }
  async function post(path, body) { return request(path, body); }
  async function request(path, body) {
    const response = await fetch(`/security/api${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Security Centerの処理に失敗しました。");
    return payload;
  }
})();

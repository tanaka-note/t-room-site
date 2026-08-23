import { WorkerEntrypoint } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import { secure } from "./security-headers.js";
import {
  AUDIT_PAGE_SIZE,
  LOGIN_FAILURE_EVENTS,
  LOGIN_SUCCESS_EVENTS,
  auditRetentionCutoff,
  bootstrapAttemptCutoff,
  canonicalServiceLinks,
  currentJstDayBounds,
  decodeAuditCursor,
  encodeAuditCursor,
  jstDayBounds,
  normalizeAuditService,
  normalizeIdentityId,
  normalizeLinkedService,
  normalizeUtcTimestamp,
  passkeySessionStateMatches,
  resolveInviteExpiry,
  validCredentialId
} from "./security-domain.js";

const BASE_PATH = "/security";
const ADMIN_COOKIE = "troom_security_admin";
const IDENTITY_COOKIE = "troom_security_identity";
const SETUP_COOKIE = "troom_security_setup";
const PRIMARY_ADMIN_ID = "primary-admin";
const CHALLENGE_TTL_SECONDS = 5 * 60;
const HANDOFF_TTL_SECONDS = 60;
const SETUP_TTL_SECONDS = 24 * 60 * 60;
const SETUP_UV_TTL_SECONDS = 5 * 60;
const PRIVILEGED_LINK_REAUTH_SECONDS = 5 * 60;
const SERVICE_REGISTRY = Object.freeze({
  cloud: Object.freeze({ displayName: "T-Cloud", binding: "CLOUD_AUTH" }),
  diary: Object.freeze({ displayName: "日記", binding: "DIARY_AUTH" }),
  billing: Object.freeze({ displayName: "請求書", binding: "BILLING_AUTH" })
});
const PRIMARY_ADMIN_CORE_LINKS = new Set([
  "cloud\u0000admin\u0000",
  "cloud\u0000subadmin\u0000",
  "diary\u0000main-admin\u0000",
  "diary\u0000main-user\u0000",
  "billing\u0000owner\u0000"
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default class SecurityWorker extends WorkerEntrypoint {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === BASE_PATH) return secure(Response.redirect(`${url.origin}${BASE_PATH}/`, 308));
      if (!url.pathname.startsWith(BASE_PATH)) return secure(new Response("ページが見つかりません。", { status: 404 }));
      const path = url.pathname.slice(BASE_PATH.length) || "/";
      if (path.startsWith("/api/")) return secure(await handleApi(request, this.env, url, path, this.ctx));
      return secure(await serveAsset(request, this.env, url, path));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Security Center request failed", safeErrorName(error));
      return secure(json({ error: status === 500 ? "Security Centerで処理を完了できませんでした。" : safeClientErrorMessage(error.message, status) }, status));
    }
  }

  async queue(batch) {
    for (const message of batch.messages) {
      try {
        await storeAuditEvent(this.env, message.body);
        message.ack();
      } catch (error) {
        console.error("Security audit ingestion failed", safeErrorName(error));
        message.retry();
      }
    }
  }

  async scheduled() {
    const retentionDays = clampNumber(this.env.AUDIT_RETENTION_DAYS, 30, 730, 180);
    const retentionCutoff = auditRetentionCutoff(retentionDays);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM security_challenges WHERE expires_at < ?").bind(nowSeconds() - 86400),
      this.env.DB.prepare("DELETE FROM security_handoffs WHERE expires_at < ?").bind(nowSeconds() - 86400),
      this.env.DB.prepare("DELETE FROM security_setup_sessions WHERE expires_at < ?").bind(nowSeconds() - 86400),
      this.env.DB.prepare("UPDATE security_invitations SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").bind(nowSeconds()),
      this.env.DB.prepare("DELETE FROM security_audit_events WHERE occurred_at < ?").bind(retentionCutoff)
    ]);
  }

  async redeemHandoff(token, service) {
    return redeemHandoff(this.env, token, service);
  }

  async validatePasskeySession(input) {
    return validatePasskeySession(this.env, input);
  }

  async recordAuditEvent(input) {
    await storeAuditEvent(this.env, input);
    return { stored: true };
  }
}

async function handleApi(request, env, url, path, context = null) {
  if (path === "/api/status" && request.method === "GET") {
    const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
    const initialized = await hasSecurityAdmin(env);
    const admin = await activeSecurityAdminSession(request, env);
    if (admin) scheduleAudit(context, recordSecuritySessionResume(env, request, admin));
    return json({ enabled: runtime.enabled, initialized, adminAuthenticated: Boolean(admin) });
  }

  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    const session = await readSecuritySession(request, env, ADMIN_COOKIE, "admin")
      || await readSecuritySession(request, env, IDENTITY_COOKIE, "identity");
    if (session) await writeLocalAudit(env, { eventType: "logout", outcome: "success", identityId: session.identityId, authMethod: "passkey" }, request);
    const headers = new Headers();
    headers.append("Set-Cookie", clearCookie(ADMIN_COOKIE, url.protocol === "https:"));
    headers.append("Set-Cookie", clearCookie(IDENTITY_COOKIE, url.protocol === "https:"));
    headers.append("Set-Cookie", clearCookie(SETUP_COOKIE, url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
  if (!runtime.enabled) throw new HttpError(503, "パスキー機能は一時停止中です。従来のID・パスワードでログインしてください。");

  if (path === "/api/setup/status" && request.method === "GET") return setupStatus(request, env);
  if (path === "/api/setup/resume" && request.method === "POST") {
    requireMutation(request, url);
    return resumeSetup(request, env, url);
  }
  if (path === "/api/tcloud/admin-config" && request.method === "GET") return primaryAdminCryptoConfig(request, env);
  if (path === "/api/setup/primary-admin/verify-password" && request.method === "POST") {
    requireMutation(request, url);
    return verifyPrimaryAdminSetupPassword(request, env);
  }

  if (path === "/api/bootstrap/options" && request.method === "POST") {
    requireMutation(request, url);
    return bootstrapOptions(request, env);
  }
  if (path === "/api/bootstrap/verify" && request.method === "POST") {
    requireMutation(request, url);
    return bootstrapVerify(request, env, url);
  }
  if (path === "/api/invite/options" && request.method === "POST") {
    requireMutation(request, url);
    return invitationOptions(request, env);
  }
  if (path === "/api/invite/verify" && request.method === "POST") {
    requireMutation(request, url);
    return invitationVerify(request, env, url);
  }
  if (path === "/api/auth/options" && request.method === "POST") {
    requireMutation(request, url);
    return authenticationOptions(request, env);
  }
  if (path === "/api/auth/verify" && request.method === "POST") {
    requireMutation(request, url);
    return authenticationVerify(request, env, url);
  }
  if (path === "/api/auth/cancelled" && request.method === "POST") {
    requireMutation(request, url);
    const body = await readJson(request, 4096);
    await writeLocalAudit(env, { eventType: "passkey_dialog_cancelled", outcome: "cancelled", authMethod: "passkey", service: normalizeAuthService(body.service) || "security" }, request);
    return json({ ok: true });
  }
  if (path === "/api/auth/handoff" && request.method === "POST") {
    requireMutation(request, url);
    return createHandoff(request, env);
  }
  if (path === "/api/prf/options" && request.method === "POST") {
    requireMutation(request, url);
    return prfOptions(request, env);
  }
  if (path === "/api/prf/verify" && request.method === "POST") {
    requireMutation(request, url);
    return prfVerify(request, env, url);
  }
  if (path === "/api/tcloud/envelope" && request.method === "POST") {
    requireMutation(request, url);
    return saveOwnTCloudEnvelope(request, env);
  }
  const admin = await requireSecurityAdmin(request, env);
  if (path === "/api/services" && request.method === "GET") return listServiceRegistry(env);
  if (path === "/api/dashboard" && request.method === "GET") return dashboard(env);
  if (path === "/api/identities" && request.method === "GET") return listIdentities(env);
  if (path === "/api/identities" && request.method === "POST") {
    requireMutation(request, url);
    return createIdentityAndInvite(request, env, admin);
  }
  if (path === "/api/audit" && request.method === "GET") return listAuditEvents(url, env);

  const identityMatch = path.match(/^\/api\/identities\/([A-Za-z0-9_-]{1,64})$/);
  if (identityMatch && request.method === "GET") return identityDetail(identityMatch[1], env);
  const addLinkMatch = path.match(/^\/api\/identities\/([A-Za-z0-9_-]{1,64})\/links$/);
  if (addLinkMatch && request.method === "POST") {
    requireMutation(request, url);
    return addIdentityLinks(addLinkMatch[1], request, env, admin);
  }
  const removeLinkMatch = path.match(/^\/api\/service-links\/([a-zA-Z0-9-]{1,64})$/);
  if (removeLinkMatch && request.method === "POST") {
    requireMutation(request, url);
    return removeIdentityLink(removeLinkMatch[1], request, env, admin);
  }
  const approveMatch = path.match(/^\/api\/identities\/([A-Za-z0-9_-]{1,64})\/approve$/);
  if (approveMatch && request.method === "POST") {
    requireMutation(request, url);
    return approveIdentity(approveMatch[1], request, env, admin);
  }
  const reinviteMatch = path.match(/^\/api\/identities\/([A-Za-z0-9_-]{1,64})\/reinvite$/);
  if (reinviteMatch && request.method === "POST") {
    requireMutation(request, url);
    return reinviteIdentity(reinviteMatch[1], request, env, admin);
  }
  const credentialRevokeMatch = path.match(/^\/api\/credentials\/([A-Za-z0-9_-]{1,4096})\/revoke$/);
  if (credentialRevokeMatch && request.method === "POST") {
    requireMutation(request, url);
    return revokeCredential(credentialRevokeMatch[1], request, env, admin);
  }
  const inviteRevokeMatch = path.match(/^\/api\/invitations\/([A-Za-z0-9_-]{1,64})\/revoke$/);
  if (inviteRevokeMatch && request.method === "POST") {
    requireMutation(request, url);
    return revokeInvitation(inviteRevokeMatch[1], request, env, admin);
  }
  throw new HttpError(404, "指定された情報が見つかりません。");
}

async function bootstrapOptions(request, env) {
  const body = await readJson(request, 8192);
  const loginId = normalizeText(body.loginId, 254).toLowerCase();
  const authProof = normalizeSecretText(body.authProof, 512);
  if (!loginId || !authProof) throw new HttpError(400, "現在のT-Cloud管理者ID・パスワードを確認してください。");
  await enforceBootstrapAttemptLimit(request, env);
  const verifiedAdmin = await env.CLOUD_AUTH.verifyPrimaryAdmin({ loginId, authProof });
  if (!verifiedAdmin?.verified || verifiedAdmin.accountId !== "admin") {
    await writeLocalAudit(env, { eventType: "bootstrap_auth_failure", outcome: "failure", authMethod: "password", serviceAccountId: "admin" }, request);
    throw new HttpError(401, "現在のT-Cloud管理者ID・パスワードを確認してください。");
  }
  await ensurePrimaryAdminRecords(env);
  const existing = await env.DB.prepare("SELECT credential_id AS id, transports_json AS transports FROM security_credentials WHERE identity_id = ? AND status != 'revoked'").bind(PRIMARY_ADMIN_ID).all();
  const options = await registrationOptions(env, PRIMARY_ADMIN_ID, "第一管理者", (existing.results || []).map((row) => ({ id: row.id, transports: parseJson(row.transports, []) })));
  const challengeId = await storeChallenge(env, "bootstrap_registration", options.challenge, PRIMARY_ADMIN_ID, null, null);
  await writeLocalAudit(env, { eventType: "bootstrap_auth_success", outcome: "success", identityId: PRIMARY_ADMIN_ID, authMethod: "password", serviceAccountId: "admin" }, request);
  return json({ challengeId, options });
}

async function bootstrapVerify(request, env, url) {
  const body = await readJson(request, 100000);
  const challenge = await consumeChallenge(env, body.challengeId, "bootstrap_registration", PRIMARY_ADMIN_ID);
  const verification = await verifyRegistration(body.response, challenge.challenge, env);
  if (!verification.verified || !verification.registrationInfo?.userVerified) throw new HttpError(401, "端末のロック解除を確認できませんでした。");
  const credential = verification.registrationInfo.credential;
  const credentialId = validCredentialId(credential.id);
  if (!credentialId) throw new HttpError(400, "パスキーIDがWebAuthnの許容範囲を超えています。");
  const prfSalt = randomToken(32);
  const setup = await prepareSetupSession(env, PRIMARY_ADMIN_ID, credentialId);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO security_credentials
      (credential_id, identity_id, public_key, counter, transports_json, device_type, backed_up, prf_enabled, prf_salt, status, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`)
      .bind(credentialId, PRIMARY_ADMIN_ID, bytesToBase64Url(credential.publicKey), Number(credential.counter || 0),
        JSON.stringify(credential.transports || []), verification.registrationInfo.credentialDeviceType,
        verification.registrationInfo.credentialBackedUp ? 1 : 0, body.prfEnabled ? 1 : 0, prfSalt),
    env.DB.prepare("UPDATE security_identities SET status = 'active', is_security_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(PRIMARY_ADMIN_ID),
    env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND (service != 'cloud' OR service_account_id = 'subadmin')").bind(PRIMARY_ADMIN_ID),
    insertSetupSessionStatement(env, setup),
    await localAuditStatement(env, { eventType: "passkey_registration", outcome: "success", identityId: PRIMARY_ADMIN_ID, authMethod: "passkey", serviceAccountId: "admin" }, request)
  ]);
  const headers = await securitySessionHeaders(env, url, PRIMARY_ADMIN_ID, credentialId, true);
  headers.append("Set-Cookie", setupCookie(setup.token, url.protocol === "https:"));
  return json({ ok: true, identityId: PRIMARY_ADMIN_ID, credentialId, prfSalt, prfEnabled: Boolean(body.prfEnabled), needsTCloudEnvelope: true }, 201, headers);
}

async function invitationOptions(request, env) {
  const body = await readJson(request, 8192);
  const token = normalizeSecretText(body.token, 512);
  const invitation = await requireUsableInvitation(env, token);
  const identity = await env.DB.prepare("SELECT id, display_name FROM security_identities WHERE id = ?").bind(invitation.identity_id).first();
  const existing = await env.DB.prepare("SELECT credential_id AS id, transports_json AS transports FROM security_credentials WHERE identity_id = ? AND status != 'revoked'").bind(identity.id).all();
  const options = await registrationOptions(env, identity.id, identity.display_name, (existing.results || []).map((row) => ({ id: row.id, transports: parseJson(row.transports, []) })));
  const challengeId = await storeChallenge(env, "invite_registration", options.challenge, identity.id, invitation.id, null);
  const cloudLinks = await env.DB.prepare("SELECT id, service_account_id, cloud_root_folder_id FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND status IN ('pending', 'active')").bind(identity.id).all();
  return json({ challengeId, identity: { id: identity.id, displayName: identity.display_name }, options, cloudLinks: (cloudLinks.results || []).map((link) => ({ id: link.id, accountId: link.service_account_id, rootFolderId: link.cloud_root_folder_id })) });
}

async function invitationVerify(request, env, url) {
  const body = await readJson(request, 150000);
  const token = normalizeSecretText(body.token, 512);
  const invitation = await requireUsableInvitation(env, token);
  const challenge = await consumeChallenge(env, body.challengeId, "invite_registration", invitation.identity_id);
  if (challenge.invitation_id !== invitation.id) throw new HttpError(401, "招待と登録処理が一致しません。");
  const currentHash = await serviceLinkSetHash(env, invitation.identity_id);
  if (currentHash !== invitation.link_set_hash) throw new HttpError(409, "招待後に連携内容が変更されました。管理者へ再招待をご依頼ください。");
  const verification = await verifyRegistration(body.response, challenge.challenge, env);
  if (!verification.verified || !verification.registrationInfo?.userVerified) throw new HttpError(401, "端末のロック解除を確認できませんでした。");
  const credential = verification.registrationInfo.credential;
  const credentialId = validCredentialId(credential.id);
  if (!credentialId) throw new HttpError(400, "パスキーIDがWebAuthnの許容範囲を超えています。");
  const prfSalt = randomToken(32);
  const setup = await prepareSetupSession(env, invitation.identity_id, credentialId);
  try {
    await env.DB.batch([
    env.DB.prepare(`INSERT INTO security_credentials
      (credential_id, identity_id, public_key, counter, transports_json, device_type, backed_up, prf_enabled, prf_salt, status, registered_via_invitation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(credentialId, invitation.identity_id, bytesToBase64Url(credential.publicKey), Number(credential.counter || 0),
        JSON.stringify(credential.transports || []), verification.registrationInfo.credentialDeviceType,
        verification.registrationInfo.credentialBackedUp ? 1 : 0, body.prfEnabled ? 1 : 0, prfSalt, invitation.id),
    env.DB.prepare("UPDATE security_invitations SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(invitation.id),
    env.DB.prepare("UPDATE security_identities SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending_approval' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invitation.identity_id),
    insertSetupSessionStatement(env, setup),
    await localAuditStatement(env, { eventType: "invite_used", outcome: "success", identityId: invitation.identity_id, authMethod: "passkey" }, request),
    await localAuditStatement(env, { eventType: "passkey_registration", outcome: "success", identityId: invitation.identity_id, authMethod: "passkey" }, request)
    ]);
  } catch (error) {
    const state = await env.DB.prepare("SELECT status FROM security_invitations WHERE id = ?").bind(invitation.id).first();
    if (state?.status === "used") throw new HttpError(410, "この招待は既に使用されています。");
    throw error;
  }
  const headers = await securitySessionHeaders(env, url, invitation.identity_id, credentialId, false);
  headers.append("Set-Cookie", setupCookie(setup.token, url.protocol === "https:"));
  return json({ ok: true, pendingApproval: true, identityId: invitation.identity_id, credentialId, prfSalt, prfEnabled: Boolean(body.prfEnabled) }, 201, headers);
}

async function authenticationOptions(request, env) {
  const body = await readJson(request, 4096);
  const service = normalizeAuthService(body.service);
  if (!service) throw new HttpError(400, "ログイン先サービスを確認してください。");
  await enforceAuthenticationOptionsRateLimit(request, env);
  const servicePredicate = service === "security"
    ? "i.is_security_admin = 1"
    : service === "cloud"
      ? `EXISTS (
          SELECT 1 FROM security_service_links l
          WHERE l.identity_id = i.id AND l.service = 'cloud' AND l.status = 'active'
            AND (
              (l.service_account_id = 'admin' AND EXISTS (
                SELECT 1 FROM security_tcloud_key_envelopes e
                WHERE e.identity_id = i.id AND e.credential_id = c.credential_id
                  AND e.service_link_id = l.id AND e.envelope_type = 'admin_private_prf'
              ))
              OR
              l.service_account_id = 'subadmin'
              OR
              (l.service_account_id = 'folder-member'
                AND EXISTS (SELECT 1 FROM security_tcloud_client_vaults v WHERE v.identity_id = i.id AND v.credential_id = c.credential_id)
                AND EXISTS (
                  SELECT 1 FROM security_tcloud_key_envelopes e
                  WHERE e.identity_id = i.id AND e.credential_id = c.credential_id
                    AND e.service_link_id = l.id AND e.envelope_type = 'folder_key_rsa'
                ))
            )
        )`
      : "EXISTS (SELECT 1 FROM security_service_links l WHERE l.identity_id = i.id AND l.service = ? AND l.status = 'active')";
  const statement = env.DB.prepare(`SELECT c.credential_id, c.transports_json, c.prf_salt
    FROM security_credentials c
    JOIN security_identities i ON i.id = c.identity_id
    WHERE c.status = 'active' AND i.status = 'active'
      AND ${servicePredicate}
    ORDER BY c.registered_at ASC`);
  const rows = await (["security", "cloud"].includes(service) ? statement.all() : statement.bind(service).all());
  if (!(rows.results || []).length) throw new HttpError(404, "パスキーが登録されていません。管理者からの招待を確認してください。");
  const extensions = ["security", "cloud"].includes(service)
    ? prfAuthenticationExtensions(rows.results)
    : undefined;
  const options = await generateAuthenticationOptions({
    rpID: rpId(env), timeout: 60000, userVerification: "required",
    allowCredentials: rows.results.map((row) => ({ id: row.credential_id, transports: parseJson(row.transports_json, []) })),
    extensions
  });
  const challengeId = await storeChallenge(env, "authentication", options.challenge, null, null, service);
  await writeLocalAudit(env, { eventType: "passkey_authentication_options", outcome: "info", authMethod: "passkey", service }, request);
  return json({ challengeId, options });
}

async function authenticationVerify(request, env, url) {
  const body = await readJson(request, 100000);
  const service = normalizeAuthService(body.service);
  const challenge = await consumeChallenge(env, body.challengeId, "authentication", null);
  if (!service || challenge.service !== service) throw new HttpError(401, "認証先サービスが一致しません。");
  const credentialId = validCredentialId(body.response?.id);
  const credential = await activeCredential(env, credentialId);
  if (!credential) {
    await writeLocalAudit(env, { eventType: "passkey_authentication_failure", outcome: "failure", authMethod: "passkey", service }, request);
    throw new HttpError(401, "パスキーを確認できませんでした。");
  }
  let verification;
  try {
    verification = await verifyAuthentication(body.response, challenge.challenge, credential, env);
  } catch (error) {
    await writeLocalAudit(env, { eventType: "passkey_authentication_failure", outcome: "failure", identityId: credential.identity_id, authMethod: "passkey", service }, request);
    throw error;
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    await writeLocalAudit(env, { eventType: "passkey_authentication_failure", outcome: "failure", identityId: credential.identity_id, authMethod: "passkey", service }, request);
    throw new HttpError(401, "パスキーを確認できませんでした。");
  }
  await env.DB.prepare("UPDATE security_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = ?")
    .bind(verification.authenticationInfo.newCounter, credentialId).run();
  const links = service === "security" ? [] : await activeLinks(env, credential.identity_id, service, credentialId);
  if (service === "security" && !credential.is_security_admin) throw new HttpError(403, "Security Centerを管理する権限がありません。");
  if (service !== "security" && !links.length) throw new HttpError(403, "このサービスへ接続されたアカウントがありません。");
  await writeLocalAudit(env, {
    eventType: service === "security" ? "passkey_login_success" : "passkey_authentication_success",
    outcome: "success", identityId: credential.identity_id, authMethod: "passkey", service
  }, request);
  const headers = await securitySessionHeaders(env, url, credential.identity_id, credentialId, Boolean(credential.is_security_admin));
  return json({ authenticated: true, credentialId, prfSalt: credential.prf_salt, links: await Promise.all(links.map((link) => publicLink(env, link))) }, 200, headers);
}

async function createHandoff(request, env) {
  const identitySession = await requireActiveIdentitySession(request, env);
  const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
  if (!runtime.enabled) throw new HttpError(503, "パスキー機能は一時停止中です。");
  const body = await readJson(request, 4096);
  const service = normalizeService(body.service);
  const links = await activeLinks(env, identitySession.identityId, service, identitySession.credentialId);
  if (!links.length) throw new HttpError(403, "このサービスへ接続されたアカウントがありません。");
  const selected = body.linkId ? links.find((link) => link.id === body.linkId) : (links.length === 1 ? links[0] : null);
  if (!selected) throw new HttpError(409, "利用するアカウントを選択してください。");
  const envelopes = service === "cloud"
    ? await tcloudEnvelopeBundle(env, identitySession.identityId, identitySession.credentialId, selected.id, selected.service_account_id)
    : null;
  if (service === "cloud") {
    const ready = selected.service_account_id === "admin"
      ? Boolean(envelopes.admin_private_prf)
      : selected.service_account_id === "subadmin"
        ? true
        : Boolean(envelopes.client_private_prf && envelopes.folder_key_rsa);
    if (!ready) throw new HttpError(409, "この端末ではT-Cloudのパスキー復号準備が完了していません。従来のID・パスワードをご利用ください。");
  }
  const rawToken = randomToken(32);
  await env.DB.prepare(`INSERT INTO security_handoffs
    (id, token_hash, identity_id, service_link_id, credential_id, session_epoch, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), await sha256(rawToken), identitySession.identityId, selected.id, identitySession.credentialId, runtime.epoch, nowSeconds() + HANDOFF_TTL_SECONDS).run();
  return json({ handoffToken: rawToken, link: await publicLink(env, selected), tcloudKey: envelopes });
}

async function setupStatus(request, env) {
  const setup = await readSetupSession(request, env, ["active", "completed"]);
  if (setup) return json(await tcloudSetupStatus(env, setup.identity_id, setup.credential_id, {
    active: setup.status === "active",
    completed: setup.status === "completed",
    resumable: false
  }));
  const actor = await currentSetupActor(request, env);
  if (!actor) return json({ active: false, resumable: false });
  const completed = await env.DB.prepare(`SELECT 1 AS ok FROM security_setup_sessions
    WHERE identity_id = ? AND credential_id = ? AND status = 'completed' LIMIT 1`)
    .bind(actor.identityId, actor.credentialId).first();
  const status = await tcloudSetupStatus(env, actor.identityId, actor.credentialId, {
    active: false,
    completed: Boolean(completed),
    resumable: !completed
  });
  status.resumable = Boolean(status.resumable && status.needsTCloudSetup && status.prfEnabled);
  return json(status);
}

async function resumeSetup(request, env, url) {
  const actor = await currentSetupActor(request, env);
  if (!actor) throw new HttpError(401, "現在のパスキーでログインしてからT-Cloudの準備を再開してください。");
  const completed = await env.DB.prepare(`SELECT 1 AS ok FROM security_setup_sessions
    WHERE identity_id = ? AND credential_id = ? AND status = 'completed' LIMIT 1`)
    .bind(actor.identityId, actor.credentialId).first();
  if (completed) throw new HttpError(409, "このパスキーのT-Cloud準備は完了済みです。");
  const status = await tcloudSetupStatus(env, actor.identityId, actor.credentialId, {
    active: false,
    completed: false,
    resumable: true
  });
  if (!status.cloudLinks.length) throw new HttpError(409, "T-Cloud連携が見つかりません。");
  if (!status.needsTCloudSetup || status.tcloudReady) throw new HttpError(409, "このパスキーのT-Cloud準備は完了済みです。");
  if (!status.prfEnabled) throw new HttpError(409, "このパスキーはT-Cloudの端末側復号に対応していません。ID・パスワードをご利用ください。");

  const setup = await prepareSetupSession(env, actor.identityId, actor.credentialId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE security_setup_sessions SET status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE identity_id = ? AND credential_id = ? AND status = 'active'`)
      .bind(actor.identityId, actor.credentialId),
    insertSetupSessionStatement(env, setup),
    await localAuditStatement(env, {
      eventType: "tcloud_setup_resumed", outcome: "success", identityId: actor.identityId,
      service: "cloud", authMethod: "passkey"
    }, request)
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", setupCookie(setup.token, url.protocol === "https:"));
  return json(await tcloudSetupStatus(env, actor.identityId, actor.credentialId, {
    active: true,
    completed: false,
    resumable: false
  }), 200, headers);
}

async function tcloudSetupStatus(env, identityId, credentialId, flags) {
  const [credential, cloudLinks, vault] = await Promise.all([
    env.DB.prepare("SELECT credential_id, prf_enabled, status FROM security_credentials WHERE credential_id = ? AND identity_id = ?").bind(credentialId, identityId).first(),
    env.DB.prepare("SELECT id, service_account_id, cloud_root_folder_id, status FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND status IN ('pending', 'active')").bind(identityId).all(),
    env.DB.prepare("SELECT public_key_fingerprint FROM security_tcloud_client_vaults WHERE credential_id = ? AND identity_id = ?").bind(credentialId, identityId).first()
  ]);
  if (!credential || credential.status === "revoked") return { active: false, resumable: false };
  const links = cloudLinks.results || [];
  let ready = Boolean(vault);
  if (identityId === PRIMARY_ADMIN_ID) {
    const envelope = await env.DB.prepare("SELECT 1 AS ok FROM security_tcloud_key_envelopes WHERE credential_id = ? AND identity_id = ? AND envelope_type = 'admin_private_prf'").bind(credentialId, identityId).first();
    ready = Boolean(envelope);
  }
  return {
    ...flags,
    identityId,
    credentialId,
    isPrimaryAdmin: identityId === PRIMARY_ADMIN_ID,
    prfEnabled: Boolean(credential.prf_enabled),
    tcloudReady: ready,
    needsTCloudSetup: Boolean(links.length && !ready),
    clientKeyFingerprint: vault?.public_key_fingerprint || null,
    cloudLinks: links.map((link) => ({ id: link.id, accountId: link.service_account_id, rootFolderId: link.cloud_root_folder_id, status: link.status }))
  };
}

async function currentSetupActor(request, env) {
  const [identitySession, adminSession] = await Promise.all([
    readSecuritySession(request, env, IDENTITY_COOKIE, "identity"),
    readSecuritySession(request, env, ADMIN_COOKIE, "admin")
  ]);
  const session = identitySession || adminSession;
  if (!session) return null;
  if (session.identityId === PRIMARY_ADMIN_ID) {
    if (!adminSession || adminSession.identityId !== session.identityId || adminSession.credentialId !== session.credentialId) return null;
  } else if (!identitySession) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT c.status AS credential_status, i.status AS identity_status, i.is_security_admin
    FROM security_credentials c JOIN security_identities i ON i.id = c.identity_id
    WHERE c.credential_id = ? AND c.identity_id = ? AND c.status IN ('pending', 'active') AND i.status != 'disabled'`)
    .bind(session.credentialId, session.identityId).first();
  if (!row) return null;
  if (session.identityId === PRIMARY_ADMIN_ID
    && (row.credential_status !== "active" || row.identity_status !== "active" || !row.is_security_admin)) return null;
  return session;
}

async function primaryAdminCryptoConfig(request, env) {
  const setup = await requireSetupSession(request, env);
  if (setup.identityId !== PRIMARY_ADMIN_ID) throw new HttpError(403, "第一管理者の復旧登録専用です。");
  const config = await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
  return json(config || { initialized: false, cryptoVersion: 1 });
}

async function verifyPrimaryAdminSetupPassword(request, env) {
  const setup = await requireSetupSession(request, env);
  if (setup.identityId !== PRIMARY_ADMIN_ID) throw new HttpError(403, "第一管理者の復旧登録専用です。");
  const body = await readJson(request, 8192);
  const loginId = normalizeText(body.loginId, 254).toLowerCase();
  const authProof = normalizeSecretText(body.authProof, 512);
  if (!loginId || !authProof) throw new HttpError(400, "現在のT-Cloud管理者ID・パスワードを確認してください。");
  await enforceBootstrapAttemptLimit(request, env);
  const verifiedAdmin = await env.CLOUD_AUTH.verifyPrimaryAdmin({ loginId, authProof });
  if (!verifiedAdmin?.verified || verifiedAdmin.accountId !== "admin") {
    await writeLocalAudit(env, { eventType: "bootstrap_auth_failure", outcome: "failure", identityId: PRIMARY_ADMIN_ID, authMethod: "password", serviceAccountId: "admin" }, request);
    throw new HttpError(401, "現在のT-Cloud管理者ID・パスワードを確認してください。");
  }
  await writeLocalAudit(env, { eventType: "bootstrap_auth_success", outcome: "success", identityId: PRIMARY_ADMIN_ID, authMethod: "password", serviceAccountId: "admin", details: { setupResume: true } }, request);
  return json({ verified: true });
}

async function prfOptions(request, env) {
  const identitySession = await requireSetupOrIdentitySession(request, env);
  const body = await readJson(request, 4096);
  const credentialId = body.credentialId || identitySession.credentialId;
  if (credentialId !== identitySession.credentialId) throw new HttpError(403, "パスキーが一致しません。");
  const credential = await credentialForIdentity(env, credentialId, identitySession.identityId);
  if (!credential) throw new HttpError(404, "パスキーが見つかりません。");
  const options = await generateAuthenticationOptions({
    rpID: rpId(env), timeout: 60000, userVerification: "required",
    allowCredentials: [{ id: credential.credential_id, transports: parseJson(credential.transports_json, []) }],
    extensions: prfAuthenticationExtensions([credential])
  });
  const challengeId = await storeChallenge(env, "prf_assertion", options.challenge, identitySession.identityId, null, null);
  return json({ challengeId, options, credentialId: credential.credential_id, prfSalt: credential.prf_salt });
}

async function prfVerify(request, env, url) {
  const identitySession = await requireSetupOrIdentitySession(request, env);
  const body = await readJson(request, 100000);
  const challenge = await consumeChallenge(env, body.challengeId, "prf_assertion", identitySession.identityId);
  const credentialId = validCredentialId(body.response?.id);
  if (credentialId !== identitySession.credentialId) throw new HttpError(403, "パスキーが一致しません。");
  const credential = await credentialForIdentity(env, credentialId, identitySession.identityId);
  const verification = await verifyAuthentication(body.response, challenge.challenge, credential, env);
  if (!verification.verified || !verification.authenticationInfo.userVerified) throw new HttpError(401, "端末のロック解除を確認できませんでした。");
  // `prf_enabled` records registration-time credential capability. An assertion
  // without a PRF result is a per-attempt outcome and must not downgrade it.
  const statements = [env.DB.prepare("UPDATE security_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = ?")
    .bind(verification.authenticationInfo.newCounter, credentialId)];
  if (identitySession.setupId) statements.push(env.DB.prepare("UPDATE security_setup_sessions SET last_user_verification_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(nowSeconds(), identitySession.setupId));
  await env.DB.batch(statements);
  const identity = await env.DB.prepare("SELECT is_security_admin FROM security_identities WHERE id = ?").bind(identitySession.identityId).first();
  const headers = await securitySessionHeaders(env, url, identitySession.identityId, credentialId, Boolean(identity?.is_security_admin));
  return json({ verified: true, prfAvailable: Boolean(body.prfAvailable) }, 200, headers);
}

async function saveOwnTCloudEnvelope(request, env) {
  const identitySession = await requireSetupSession(request, env);
  if (!identitySession.last_user_verification_at || Number(identitySession.last_user_verification_at) < nowSeconds() - SETUP_UV_TTL_SECONDS) {
    throw new HttpError(401, "端末のロック解除をもう一度確認してください。");
  }
  const body = await readJson(request, 100000);
  const link = await env.DB.prepare(`SELECT l.*, i.is_security_admin FROM security_service_links l
    JOIN security_identities i ON i.id = l.identity_id
    WHERE l.id = ? AND l.identity_id = ? AND l.service = 'cloud'`)
    .bind(body.serviceLinkId, identitySession.identityId).first();
  const envelopeType = body.envelopeType === "admin_private_prf" ? body.envelopeType : "client_private_prf";
  if (envelopeType === "admin_private_prf" && !link) throw new HttpError(404, "T-Cloud連携が見つかりません。");
  if (envelopeType === "admin_private_prf" && (link.service_account_id !== "admin" || !link.is_security_admin)) {
    throw new HttpError(403, "管理者用の暗号鍵envelopeは第一管理者だけが登録できます。");
  }
  if (envelopeType === "client_private_prf") {
    const memberLink = await env.DB.prepare("SELECT 1 AS ok FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND service_account_id = 'folder-member' AND cloud_root_folder_id IS NOT NULL AND status IN ('pending', 'active') LIMIT 1").bind(identitySession.identityId).first();
    if (!memberLink) throw new HttpError(403, "一般ユーザー用のT-Cloud連携を確認してください。");
  }
  const publicKeyJwk = body.publicKeyJwk ? validatePublicJwk(body.publicKeyJwk) : null;
  const encryptedPayload = normalizeSecretText(body.encryptedPayload, 24000);
  const payloadIv = normalizeSecretText(body.payloadIv, 128);
  if (!encryptedPayload || !payloadIv || (envelopeType === "client_private_prf" && !publicKeyJwk)) throw new HttpError(400, "暗号鍵envelopeを確認してください。");
  const statements = [];
  let alreadyExisting = false;
  if (envelopeType === "client_private_prf") {
    const fingerprint = await sha256(canonicalJwk(publicKeyJwk));
    const existing = await env.DB.prepare("SELECT public_key_fingerprint, public_key_jwk FROM security_tcloud_client_vaults WHERE credential_id = ? AND identity_id = ?").bind(identitySession.credentialId, identitySession.identityId).first();
    alreadyExisting = Boolean(existing);
    const existingFingerprint = existing?.public_key_fingerprint || (existing?.public_key_jwk ? await sha256(canonicalJwk(parseJson(existing.public_key_jwk, null))) : null);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new HttpError(409, "このパスキーのT-Cloudクライアント鍵は既に登録されています。鍵ローテーションには再招待が必要です。");
    }
    statements.push(env.DB.prepare(`INSERT INTO security_tcloud_client_vaults
      (credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        public_key_jwk = excluded.public_key_jwk, public_key_fingerprint = excluded.public_key_fingerprint,
        encrypted_payload = excluded.encrypted_payload, payload_iv = excluded.payload_iv, updated_at = CURRENT_TIMESTAMP`)
      .bind(identitySession.credentialId, identitySession.identityId, JSON.stringify(publicKeyJwk), fingerprint, encryptedPayload, payloadIv));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk, encrypted_payload, payload_iv)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id, service_link_id, envelope_type) DO UPDATE SET
        public_key_jwk = excluded.public_key_jwk, encrypted_payload = excluded.encrypted_payload,
        payload_iv = excluded.payload_iv, updated_at = CURRENT_TIMESTAMP`)
      .bind(crypto.randomUUID(), identitySession.identityId, identitySession.credentialId, link.id, envelopeType,
        null, encryptedPayload, payloadIv));
  }
  if (envelopeType === "admin_private_prf") {
    statements.push(env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ?").bind(link.id, identitySession.identityId));
  }
  statements.push(env.DB.prepare("UPDATE security_setup_sessions SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(identitySession.setupId));
  statements.push(await localAuditStatement(env, { eventType: "tcloud_key_envelope_saved", outcome: "success", identityId: identitySession.identityId, service: "cloud", authMethod: "passkey" }, request));
  await env.DB.batch(statements);
  return json({ ok: true, existing: alreadyExisting });
}

async function dashboard(env) {
  const today = currentJstDayBounds();
  const successPlaceholders = LOGIN_SUCCESS_EVENTS.map(() => "?").join(", ");
  const failurePlaceholders = LOGIN_FAILURE_EVENTS.map(() => "?").join(", ");
  const counts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? AND outcome = 'success' AND event_type IN (${successPlaceholders}) THEN 1 ELSE 0 END) AS loginSuccess,
    SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? AND outcome = 'failure' AND event_type IN (${failurePlaceholders}) THEN 1 ELSE 0 END) AS loginFailure,
    SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? AND outcome = 'blocked' THEN 1 ELSE 0 END) AS lockouts,
    SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? AND event_type = 'session_resume' THEN 1 ELSE 0 END) AS sessionResume,
    SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? AND event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END) AS critical
    FROM security_audit_events`).bind(
      today.start, today.end, ...LOGIN_SUCCESS_EVENTS,
      today.start, today.end, ...LOGIN_FAILURE_EVENTS,
      today.start, today.end,
      today.start, today.end,
      today.start, today.end
    ).first();
  const identityCounts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'pending') THEN 1 ELSE 0 END) AS pendingApproval,
    SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) AS invited,
    SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'active') THEN 1 ELSE 0 END) AS noPasskey
    FROM security_identities i`).first();
  return json({ loginSuccess: Number(counts?.loginSuccess || 0), loginFailure: Number(counts?.loginFailure || 0), lockouts: Number(counts?.lockouts || 0), sessionResume: Number(counts?.sessionResume || 0), critical: Number(counts?.critical || 0), pendingApproval: Number(identityCounts?.pendingApproval || 0), invited: Number(identityCounts?.invited || 0), noPasskey: Number(identityCounts?.noPasskey || 0) });
}

async function listServiceRegistry(env) {
  const services = [];
  for (const [id, descriptor] of Object.entries(SERVICE_REGISTRY)) {
    const provider = serviceProvider(env, id);
    let response;
    try {
      response = await provider.listLinkTargets();
    } catch {
      throw new HttpError(503, `${descriptor.displayName}の連携候補を取得できません。時間を置いて再度お試しください。`);
    }
    const targets = Array.isArray(response?.targets) ? response.targets.map((target) => {
      const normalized = publicServiceTarget(id, target);
      return normalized ? { service: id, ...normalized } : null;
    }).filter(Boolean) : [];
    services.push({ id, displayName: normalizeText(response?.displayName, 80) || descriptor.displayName, targets });
  }
  return json({ services });
}

async function listIdentities(env) {
  const result = await env.DB.prepare(`SELECT i.id, i.display_name, i.status, i.is_security_admin, i.last_login_at, i.last_seen_at,
    COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.credential_id END) AS activeCredentials,
    COUNT(DISTINCT CASE WHEN c.status = 'pending' THEN c.credential_id END) AS pendingCredentials,
    MAX(CASE WHEN inv.status = 'active' THEN inv.expires_at END) AS inviteExpiresAt
    FROM security_identities i
    LEFT JOIN security_credentials c ON c.identity_id = i.id
    LEFT JOIN security_invitations inv ON inv.identity_id = i.id
    GROUP BY i.id ORDER BY i.is_security_admin DESC, i.display_name COLLATE NOCASE`).all();
  return json({ identities: (result.results || []).map((row) => ({ id: row.id, displayName: row.display_name, status: row.status, isSecurityAdmin: Boolean(row.is_security_admin), lastLoginAt: normalizeUtcTimestamp(row.last_login_at), lastSeenAt: normalizeUtcTimestamp(row.last_seen_at), activeCredentials: Number(row.activeCredentials || 0), pendingCredentials: Number(row.pendingCredentials || 0), inviteExpiresAt: row.inviteExpiresAt ? Number(row.inviteExpiresAt) : null })) });
}

async function identityDetail(id, env) {
  const identity = await env.DB.prepare("SELECT * FROM security_identities WHERE id = ?").bind(id).first();
  if (!identity) throw new HttpError(404, "Identityが見つかりません。");
  const [links, credentials, invitations, audits] = await Promise.all([
    env.DB.prepare("SELECT * FROM security_service_links WHERE identity_id = ? ORDER BY service, created_at").bind(id).all(),
    env.DB.prepare("SELECT credential_id, transports_json, device_type, backed_up, prf_enabled, status, label, registered_at, approved_at, last_used_at, revoked_at FROM security_credentials WHERE identity_id = ? ORDER BY registered_at DESC").bind(id).all(),
    env.DB.prepare("SELECT id, expires_at, status, created_at, used_at, revoked_at FROM security_invitations WHERE identity_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all(),
    env.DB.prepare("SELECT * FROM security_audit_events WHERE identity_id = ? ORDER BY occurred_at DESC LIMIT 50").bind(id).all()
  ]);
  const linkRows = links.results || [];
  const adminKeyRows = identity.is_security_admin ? await env.DB.prepare("SELECT credential_id, encrypted_payload, payload_iv FROM security_tcloud_key_envelopes WHERE identity_id = ? AND envelope_type = 'admin_private_prf'").bind(id).all() : { results: [] };
  const linkDetails = [];
  const cloudFolders = new Map();
  for (const link of linkRows.filter((item) => item.service === "cloud" && item.cloud_root_folder_id != null)) {
    try {
      const folder = await env.CLOUD_AUTH.getFolderCryptoRecord(link.cloud_root_folder_id);
      if (folder) cloudFolders.set(link.id, { serviceLinkId: link.id, folder, folderUnavailable: false });
      else cloudFolders.set(link.id, { serviceLinkId: link.id, folder: null, folderUnavailable: true });
    } catch {
      cloudFolders.set(link.id, { serviceLinkId: link.id, folder: null, folderUnavailable: true });
    }
  }
  for (const link of linkRows) {
    let description = null;
    try { description = await serviceProvider(env, link.service).describeAccount({ accountId: link.service_account_id, rootFolderId: link.cloud_root_folder_id }); }
    catch { /* keep the stored server-validated snapshot */ }
    linkDetails.push({
      ...withUtcTimes(link),
      display_label: normalizeText(description?.displayLabel, 160) || link.display_label,
      role: normalizeText(description?.role, 80) || null,
      role_label: normalizeText(description?.roleLabel, 80) || null,
      protected: isPrimaryAdminCoreLink(link),
      ...(cloudFolders.get(link.id) || {})
    });
  }
  const credentialRows = credentials.results || [];
  const currentCloudLinks = linkRows.filter((link) => link.service === "cloud" && link.service_account_id === "folder-member" && ["pending", "active"].includes(link.status));
  const approvalCandidates = [];
  for (const credential of credentialRows.filter((item) => ["pending", "active"].includes(item.status))) {
    const vault = await env.DB.prepare("SELECT public_key_jwk, public_key_fingerprint FROM security_tcloud_client_vaults WHERE identity_id = ? AND credential_id = ?").bind(id, credential.credential_id).first();
    const envelopeRows = await env.DB.prepare(`SELECT service_link_id FROM security_tcloud_key_envelopes
      WHERE identity_id = ? AND credential_id = ? AND envelope_type = 'folder_key_rsa'`)
      .bind(id, credential.credential_id).all();
    const readyLinkIds = new Set((envelopeRows.results || []).map((row) => row.service_link_id));
    const missingCloudLinks = currentCloudLinks.filter((link) => !readyLinkIds.has(link.id));
    if (credential.status !== "pending" && !missingCloudLinks.length) continue;
    approvalCandidates.push({
      credentialId: credential.credential_id,
      status: credential.status,
      registeredAt: normalizeUtcTimestamp(credential.registered_at),
      deviceType: credential.device_type || null,
      backedUp: Boolean(credential.backed_up),
      prfEnabled: Boolean(credential.prf_enabled),
      hasCloudLinks: Boolean(currentCloudLinks.length),
      cloudClientReady: Boolean(vault),
      cloudReadyCount: currentCloudLinks.length - missingCloudLinks.length,
      cloudPendingCount: missingCloudLinks.length,
      cloudApproval: vault && missingCloudLinks.length ? {
        credentialId: credential.credential_id,
        publicKeyJwk: parseJson(vault.public_key_jwk, null),
        publicKeyFingerprint: vault.public_key_fingerprint || null,
        folders: missingCloudLinks.map((link) => cloudFolders.get(link.id) || { serviceLinkId: link.id, folder: null, folderUnavailable: true })
      } : null
    });
  }
  const firstCandidate = approvalCandidates[0] || null;
  return json({
    identity: { id: identity.id, displayName: identity.display_name, status: identity.status, isSecurityAdmin: Boolean(identity.is_security_admin), lastLoginAt: normalizeUtcTimestamp(identity.last_login_at), lastSeenAt: normalizeUtcTimestamp(identity.last_seen_at) },
    links: linkDetails,
    credentials: credentialRows.map((row) => ({ ...withUtcTimes(row), backed_up: Boolean(row.backed_up), prf_enabled: Boolean(row.prf_enabled) })),
    pendingCredentialId: firstCandidate?.credentialId || null,
    approvalCandidates,
    invitations: (invitations.results || []).map(withUtcTimes),
    audits: (audits.results || []).map(withUtcTimes),
    cloudApproval: firstCandidate?.cloudApproval || null,
    adminKeyEnvelopes: (adminKeyRows.results || []).map((row) => ({ credentialId: row.credential_id, encryptedPayload: row.encrypted_payload, payloadIv: row.payload_iv }))
  });
}

async function createIdentityAndInvite(request, env, admin) {
  const body = await readJson(request, 20000);
  const displayName = normalizeText(body.displayName, 100);
  const hasIdentityId = Object.hasOwn(body, "identityId");
  const identityId = hasIdentityId ? normalizeIdentityId(body.identityId) : crypto.randomUUID();
  if (!displayName) throw new HttpError(400, "表示名を入力してください。");
  if (!identityId) throw new HttpError(400, "Identity IDは英数字・_・-を使い64文字以内で入力してください。");
  const links = await validateServiceLinks(env, body.links, { identityId, admin });
  if (!links.length) throw new HttpError(400, "少なくとも1つのサービス連携を指定してください。");
  assertUniqueServiceLinks(links);
  const existing = await env.DB.prepare("SELECT 1 AS ok FROM security_identities WHERE id = ?").bind(identityId).first();
  if (existing) throw new HttpError(409, "同じIdentity IDが既に存在します。");
  const invitation = await prepareInvitation(env, identityId, body, admin.identityId, await serviceLinkHashFromLinks(links));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO security_identities (id, display_name, status) VALUES (?, ?, 'invited')").bind(identityId, displayName),
    ...links.map((link) => insertServiceLinkStatement(env, identityId, link)),
    insertInvitationStatement(env, invitation),
    await localAuditStatement(env, { eventType: "identity_created", outcome: "success", identityId, authMethod: "passkey" }, request),
    await localAuditStatement(env, { eventType: "invite_created", outcome: "success", identityId, authMethod: "passkey", details: { expiresAt: invitation.expiresAt } }, request)
  ]);
  return json({ identityId, invitationUrl: `/security/#invite=${encodeURIComponent(invitation.token)}`, expiresAt: invitation.expiresAt }, 201);
}

async function addIdentityLinks(identityId, request, env, admin) {
  const identity = await env.DB.prepare("SELECT id, status FROM security_identities WHERE id = ? AND status != 'disabled'").bind(identityId).first();
  if (!identity) throw new HttpError(404, "Identityが見つかりません。");
  const body = await readJson(request, 20000);
  const links = await validateServiceLinks(env, body.links, { identityId, admin });
  if (!links.length) throw new HttpError(400, "追加するサービス連携を指定してください。");
  assertUniqueServiceLinks(links);
  const existing = await env.DB.prepare("SELECT id, service, service_account_id, cloud_root_folder_id, status FROM security_service_links WHERE identity_id = ?").bind(identityId).all();
  const statements = [];
  for (const link of links) {
    const current = (existing.results || []).find((row) => serviceLinkKey({ service: row.service, accountId: row.service_account_id, rootFolderId: row.cloud_root_folder_id }) === serviceLinkKey(link) && row.status !== "disabled");
    if (current) throw new HttpError(409, "同じサービス連携が既に存在します。");
    // A disabled link ID is a permanent revocation marker. Re-adding the same
    // account always creates a fresh ID so old service cookies can never revive.
    const status = identity.status === "active" && link.service !== "cloud" ? "active" : "pending";
    statements.push(insertServiceLinkStatement(env, identityId, link, status));
  }
  statements.push(env.DB.prepare("UPDATE security_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(identityId));
  statements.push(await localAuditStatement(env, { eventType: "service_link_added", outcome: "success", identityId, authMethod: "passkey", details: { changedBy: admin.identityId, count: links.length } }, request));
  await env.DB.batch(statements);
  return json({ ok: true, requiresReinvite: identity.status !== "active", requiresApproval: links.some((link) => link.service === "cloud") });
}

async function removeIdentityLink(linkId, request, env, admin) {
  const link = await env.DB.prepare("SELECT id, identity_id, service, service_account_id, cloud_root_folder_id FROM security_service_links WHERE id = ?").bind(linkId).first();
  if (!link) throw new HttpError(404, "サービス連携が見つかりません。");
  if (link.identity_id === PRIMARY_ADMIN_ID && isPrimaryAdminCoreLink(link)) throw new HttpError(409, "第一管理者の既定サービス連携は解除できません。");
  await env.DB.batch([
    env.DB.prepare("UPDATE security_service_links SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(linkId),
    await localAuditStatement(env, { eventType: "service_link_removed", outcome: "success", identityId: link.identity_id, service: link.service, serviceAccountId: link.service_account_id, authMethod: "passkey", details: { changedBy: admin.identityId } }, request)
  ]);
  return json({ ok: true });
}

async function approveIdentity(identityId, request, env, admin) {
  const body = await readJson(request, 120000);
  const identity = await env.DB.prepare("SELECT * FROM security_identities WHERE id = ?").bind(identityId).first();
  if (!identity || !["pending_approval", "active"].includes(identity.status)) throw new HttpError(409, "承認待ちのIdentityではありません。");
  const credentialId = normalizeSecretText(body.credentialId, 2048);
  const credential = await env.DB.prepare("SELECT credential_id, status FROM security_credentials WHERE identity_id = ? AND credential_id = ? AND status IN ('pending', 'active')")
    .bind(identityId, credentialId).first();
  if (!credential) throw new HttpError(409, "承認待ちのパスキーが見つかりません。");
  const cloudLinks = await env.DB.prepare("SELECT * FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND service_account_id = 'folder-member' AND status IN ('pending', 'active')").bind(identityId).all();
  const pendingLinks = await env.DB.prepare("SELECT 1 AS ok FROM security_service_links WHERE identity_id = ? AND status = 'pending' LIMIT 1").bind(identityId).first();
  const existingFolderEnvelopes = await env.DB.prepare(`SELECT service_link_id FROM security_tcloud_key_envelopes
    WHERE identity_id = ? AND credential_id = ? AND envelope_type = 'folder_key_rsa'`)
    .bind(identityId, credentialId).all();
  const existingFolderLinkIds = new Set((existingFolderEnvelopes.results || []).map((row) => row.service_link_id));
  const missingCloudLinks = (cloudLinks.results || []).filter((link) => !existingFolderLinkIds.has(link.id));
  if (credential.status === "active" && !pendingLinks && !missingCloudLinks.length) throw new HttpError(409, "承認待ちの連携が見つかりません。");
  let cloudPasskeyReady = !(cloudLinks.results || []).length;
  let validatedCloudEnvelopes = [];
  if ((cloudLinks.results || []).length) {
    const clientEnvelope = await env.DB.prepare("SELECT public_key_jwk FROM security_tcloud_client_vaults WHERE identity_id = ? AND credential_id = ?").bind(identityId, credential?.credential_id || "").first();
    if (clientEnvelope) {
      const delegated = Array.isArray(body.cloudEnvelopes) ? body.cloudEnvelopes : [];
      for (const link of missingCloudLinks) {
        const envelope = delegated.find((item) => item.serviceLinkId === link.id);
        if (!envelope?.wrappedKey) throw new HttpError(400, "T-Cloudフォルダ鍵の安全な委譲が完了していません。");
        const wrappedKey = normalizeSecretText(envelope.wrappedKey, 12000);
        if (!wrappedKey) throw new HttpError(400, "T-Cloudフォルダ鍵の安全な委譲を確認できません。");
        validatedCloudEnvelopes.push({ linkId: link.id, wrappedKey });
      }
      cloudPasskeyReady = true;
    }
  }
  const updates = [
    ...validatedCloudEnvelopes.map((envelope) => env.DB.prepare(`INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
      VALUES (?, ?, ?, ?, 'folder_key_rsa', ?)
      ON CONFLICT(credential_id, service_link_id, envelope_type) DO UPDATE SET
        wrapped_key = excluded.wrapped_key, updated_at = CURRENT_TIMESTAMP`)
      .bind(crypto.randomUUID(), identityId, credential.credential_id, envelope.linkId, envelope.wrappedKey)),
    env.DB.prepare("UPDATE security_credentials SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND credential_id = ? AND status = 'pending'").bind(identityId, credentialId),
    env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND status = 'pending' AND service != 'cloud'").bind(identityId),
    env.DB.prepare("UPDATE security_identities SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(identityId)
  ];
  if (cloudPasskeyReady) updates.push(env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND status = 'pending' AND service = 'cloud'").bind(identityId));
  updates.push(await localAuditStatement(env, { eventType: "identity_approved", outcome: "success", identityId, authMethod: "passkey", details: { approvedBy: admin.identityId, tcloudPasskeyReady: cloudPasskeyReady } }, request));
  await env.DB.batch(updates);
  return json({ ok: true, tcloudPasskeyReady: cloudPasskeyReady });
}

async function reinviteIdentity(identityId, request, env, admin) {
  const identity = await env.DB.prepare("SELECT id FROM security_identities WHERE id = ? AND status != 'disabled'").bind(identityId).first();
  if (!identity) throw new HttpError(404, "Identityが見つかりません。");
  const body = await readJson(request, 4096);
  const invitation = await prepareInvitation(env, identityId, body, admin.identityId);
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM security_invitations WHERE identity_id = ? AND status = 'active'").bind(identityId).first();
  const revokedPriorInvites = Number(active?.count || 0);
  await env.DB.batch([
    env.DB.prepare("UPDATE security_invitations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND status = 'active'").bind(identityId),
    insertInvitationStatement(env, invitation),
    await localAuditStatement(env, { eventType: "reinvite", outcome: "success", identityId, authMethod: "passkey", details: { expiresAt: invitation.expiresAt, revokedPriorInvites } }, request)
  ]);
  return json({ invitationUrl: `/security/#invite=${encodeURIComponent(invitation.token)}`, expiresAt: invitation.expiresAt }, 201);
}

async function revokeCredential(credentialId, request, env, admin) {
  credentialId = validCredentialId(credentialId);
  if (!credentialId) throw new HttpError(400, "パスキーIDを確認してください。");
  const credential = await env.DB.prepare("SELECT identity_id FROM security_credentials WHERE credential_id = ? AND status != 'revoked'").bind(credentialId).first();
  if (!credential) throw new HttpError(404, "パスキーが見つかりません。");
  await env.DB.batch([
    env.DB.prepare("UPDATE security_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE credential_id = ? AND status != 'revoked'").bind(credentialId),
    await localAuditStatement(env, { eventType: "passkey_revoked", outcome: "success", identityId: credential.identity_id, authMethod: "passkey", details: { revokedBy: admin.identityId } }, request)
  ]);
  return json({ ok: true });
}

async function revokeInvitation(invitationId, request, env, admin) {
  const row = await env.DB.prepare("SELECT identity_id FROM security_invitations WHERE id = ? AND status = 'active'").bind(invitationId).first();
  if (!row) throw new HttpError(404, "有効な招待が見つかりません。");
  await env.DB.batch([
    env.DB.prepare("UPDATE security_invitations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invitationId),
    await localAuditStatement(env, { eventType: "invite_revoked", outcome: "success", identityId: row.identity_id, authMethod: "passkey", details: { revokedBy: admin.identityId } }, request)
  ]);
  return json({ ok: true });
}

async function listAuditEvents(url, env) {
  const clauses = ["1 = 1"];
  const values = [];
  for (const [parameter, column, normalize] of [
    ["service", "service", normalizeAuditService], ["identityId", "identity_id", normalizeIdentityId],
    ["authMethod", "auth_method", (value) => ["password", "passkey", "system"].includes(value) ? value : ""],
    ["outcome", "outcome", (value) => ["success", "failure", "blocked", "cancelled", "info"].includes(value) ? value : ""],
    ["eventType", "event_type", (value) => normalizeText(value, 80)]
  ]) {
    const value = normalize(url.searchParams.get(parameter));
    if (value) { clauses.push(`${column} = ?`); values.push(value); }
  }
  const from = jstDayBounds(url.searchParams.get("from"));
  const to = jstDayBounds(url.searchParams.get("to"));
  if (from) { clauses.push("occurred_at >= ?"); values.push(from.start); }
  if (to) { clauses.push("occurred_at < ?"); values.push(to.end); }
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor) {
    let cursor;
    try { cursor = decodeAuditCursor(rawCursor); }
    catch { throw new HttpError(400, "監査履歴のcursorが不正です。"); }
    clauses.push("(occurred_at < ? OR (occurred_at = ? AND event_id > ?))");
    values.push(cursor.occurredAt, cursor.occurredAt, cursor.eventId);
  }
  const result = await env.DB.prepare(`SELECT * FROM security_audit_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY occurred_at DESC, event_id ASC LIMIT ?`)
    .bind(...values, AUDIT_PAGE_SIZE + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  return json({
    events: page.map(withUtcTimes),
    nextCursor: hasMore && page.length ? encodeAuditCursor(page.at(-1)) : null
  });
}

async function redeemHandoff(env, token, service) {
  const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
  if (!runtime.enabled) return null;
  const normalizedService = normalizeService(service);
  const tokenHash = await sha256(normalizeSecretText(token, 512));
  if (!normalizedService || !tokenHash) return null;
  const now = nowSeconds();
  const row = await env.DB.prepare(`SELECT h.id, h.identity_id, h.credential_id,
      l.id AS serviceLinkId, l.service, l.service_account_id AS serviceAccountId,
      l.cloud_root_folder_id AS cloudRootFolderId, l.display_label AS displayLabel
    FROM security_handoffs h JOIN security_service_links l ON l.id = h.service_link_id
    JOIN security_identities i ON i.id = h.identity_id
    JOIN security_credentials c ON c.credential_id = h.credential_id AND c.identity_id = h.identity_id
    WHERE h.token_hash = ? AND h.consumed_at IS NULL AND h.expires_at > ? AND h.session_epoch = ?
      AND l.service = ? AND l.status = 'active' AND i.status = 'active' AND c.status = 'active'`)
    .bind(tokenHash, now, runtime.epoch, normalizedService).first();
  if (!row) return null;
  const update = await env.DB.prepare("UPDATE security_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(now, row.id).run();
  if (!update.meta?.changes) return null;
  return { identityId: row.identity_id, credentialId: row.credential_id, serviceLinkId: row.serviceLinkId, service: row.service, serviceAccountId: row.serviceAccountId, cloudRootFolderId: row.cloudRootFolderId == null ? null : Number(row.cloudRootFolderId), displayLabel: row.displayLabel, sessionEpoch: runtime.epoch };
}

async function validatePasskeySession(env, input) {
  const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
  const service = normalizeLinkedService(input?.service);
  const identityId = normalizeIdentityId(input?.identityId);
  const credentialId = validCredentialId(input?.credentialId);
  const serviceLinkId = normalizeId(input?.serviceLinkId);
  const serviceAccountId = normalizeText(input?.serviceAccountId, 100);
  const sessionEpoch = Number(input?.sessionEpoch);
  if (!runtime.enabled || !service || !identityId || !credentialId || !serviceLinkId || !serviceAccountId || !Number.isInteger(sessionEpoch)) return { valid: false };
  const row = await env.DB.prepare(`SELECT c.credential_id, c.identity_id, l.id AS link_id, l.service,
      l.service_account_id, l.cloud_root_folder_id, ? AS session_epoch
    FROM security_credentials c
    JOIN security_identities i ON i.id = c.identity_id
    JOIN security_service_links l ON l.identity_id = i.id
    WHERE c.credential_id = ? AND c.identity_id = ? AND c.status = 'active'
      AND i.status = 'active' AND l.id = ? AND l.service = ? AND l.status = 'active'`)
    .bind(runtime.epoch, credentialId, identityId, serviceLinkId, service).first();
  return { valid: passkeySessionStateMatches({ ...input, identityId, credentialId, serviceLinkId, service, serviceAccountId, sessionEpoch }, row, runtime.enabled) };
}

async function registrationOptions(env, identityId, displayName, excludeCredentials) {
  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME || "T-ROOM", rpID: rpId(env), userID: encoder.encode(identityId),
    userName: identityId, userDisplayName: displayName, timeout: 60000, attestationType: "none",
    excludeCredentials, supportedAlgorithmIDs: [-7, -257], preferredAuthenticatorType: "localDevice",
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
    extensions: { credProps: true, prf: {} }
  });
  return options;
}

async function verifyRegistration(response, expectedChallenge, env) {
  try {
    return await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: expectedOrigins(env), expectedRPID: rpId(env), requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
  } catch (error) {
    console.warn("WebAuthn registration rejected", safeErrorName(error));
    throw new HttpError(401, "パスキー登録を確認できませんでした。");
  }
}

async function verifyAuthentication(response, expectedChallenge, credential, env) {
  try {
    return await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: expectedOrigins(env), expectedRPID: rpId(env), requireUserVerification: true,
      credential: { id: credential.credential_id, publicKey: base64UrlToBytes(credential.public_key), counter: Number(credential.counter || 0), transports: parseJson(credential.transports_json, []) }
    });
  } catch (error) {
    console.warn("WebAuthn authentication rejected", safeErrorName(error));
    throw new HttpError(401, "パスキーを確認できませんでした。");
  }
}

async function storeChallenge(env, purpose, challenge, identityId, invitationId, service) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO security_challenges
    (id, purpose, challenge_hash, identity_id, invitation_id, service, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, purpose, await sha256(challenge), identityId, invitationId, service, nowSeconds() + CHALLENGE_TTL_SECONDS).run();
  return id;
}

async function consumeChallenge(env, id, purpose, identityId) {
  const challenge = await env.DB.prepare("SELECT * FROM security_challenges WHERE id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(normalizeId(id), purpose, nowSeconds()).first();
  if (!challenge || (identityId && challenge.identity_id !== identityId)) throw new HttpError(401, "認証処理の有効期限が切れています。もう一度お試しください。");
  const update = await env.DB.prepare("UPDATE security_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(nowSeconds(), challenge.id).run();
  if (!update.meta?.changes) throw new HttpError(401, "この認証処理は既に使用されています。");
  // SimpleWebAuthn needs the original challenge. It is supplied by the browser response,
  // and this predicate only accepts a value whose hash matches the one-time DB record.
  return { ...challenge, challenge: async (value) => (await sha256(value)) === challenge.challenge_hash };
}

async function activeCredential(env, credentialId) {
  return env.DB.prepare(`SELECT c.*, i.is_security_admin FROM security_credentials c
    JOIN security_identities i ON i.id = c.identity_id
    WHERE c.credential_id = ? AND c.status = 'active' AND i.status = 'active'`).bind(credentialId).first();
}

async function credentialForIdentity(env, credentialId, identityId) {
  return env.DB.prepare("SELECT * FROM security_credentials WHERE credential_id = ? AND identity_id = ? AND status != 'revoked'").bind(credentialId, identityId).first();
}

async function activeLinks(env, identityId, service, credentialId) {
  const readiness = service === "cloud" ? ` AND (
      (service_account_id = 'admin' AND EXISTS (
        SELECT 1 FROM security_tcloud_key_envelopes e
        WHERE e.identity_id = security_service_links.identity_id AND e.credential_id = ?
          AND e.service_link_id = security_service_links.id AND e.envelope_type = 'admin_private_prf'
      ))
      OR
      service_account_id = 'subadmin'
      OR
      (service_account_id = 'folder-member'
        AND EXISTS (SELECT 1 FROM security_tcloud_client_vaults v WHERE v.identity_id = security_service_links.identity_id AND v.credential_id = ?)
        AND EXISTS (
          SELECT 1 FROM security_tcloud_key_envelopes e
          WHERE e.identity_id = security_service_links.identity_id AND e.credential_id = ?
            AND e.service_link_id = security_service_links.id AND e.envelope_type = 'folder_key_rsa'
        ))
    )` : "";
  const statement = env.DB.prepare(`SELECT * FROM security_service_links
    WHERE identity_id = ? AND service = ? AND status = 'active'${readiness} ORDER BY created_at`);
  const result = service === "cloud"
    ? await statement.bind(identityId, service, credentialId, credentialId, credentialId).all()
    : await statement.bind(identityId, service).all();
  return result.results || [];
}

async function requireUsableInvitation(env, token) {
  if (!token) throw new HttpError(400, "招待URLを確認してください。");
  const invitation = await env.DB.prepare("SELECT * FROM security_invitations WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!invitation) throw new HttpError(404, "招待が見つかりません。");
  if (invitation.status === "revoked") throw new HttpError(410, "この招待は取り消されています。");
  if (invitation.status === "used") throw new HttpError(410, "この招待は既に使用されています。");
  if (invitation.status !== "active" || Number(invitation.expires_at) <= nowSeconds()) {
    if (invitation.status === "active") await env.DB.prepare("UPDATE security_invitations SET status = 'expired' WHERE id = ?").bind(invitation.id).run();
    throw new HttpError(410, "この招待の有効期限が切れています。");
  }
  return invitation;
}

async function prepareInvitation(env, identityId, expiryInput, createdBy, linkSetHash = null) {
  let expiresAt;
  try {
    expiresAt = resolveInviteExpiry(expiryInput, nowSeconds(), clampNumber(env.MAX_INVITE_DAYS, 1, 30, 30));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "招待の有効期限を確認してください。");
  }
  const token = randomToken(32);
  const id = crypto.randomUUID();
  return {
    id, token, identityId, expiresAt, createdBy,
    tokenHash: await sha256(token),
    linkSetHash: linkSetHash || await serviceLinkSetHash(env, identityId)
  };
}

function insertInvitationStatement(env, invitation) {
  return env.DB.prepare(`INSERT INTO security_invitations
    (id, identity_id, token_hash, link_set_hash, expires_at, created_by_identity_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(invitation.id, invitation.identityId, invitation.tokenHash, invitation.linkSetHash, invitation.expiresAt, invitation.createdBy);
}

async function serviceLinkSetHash(env, identityId) {
  const result = await env.DB.prepare("SELECT service, service_account_id, cloud_root_folder_id, status FROM security_service_links WHERE identity_id = ?").bind(identityId).all();
  return sha256(JSON.stringify(canonicalServiceLinks(result.results || [])));
}

async function serviceLinkHashFromLinks(links) {
  return sha256(JSON.stringify(canonicalServiceLinks(links)));
}

async function validateServiceLinks(env, input, { identityId = null, admin = null } = {}) {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length > 12) throw new HttpError(400, "一度に追加できるサービス連携は12件までです。");
  const links = [];
  for (const item of raw) {
    const service = normalizeLinkedService(item.service);
    const accountId = normalizeText(item.accountId, 100);
    const rootFolderId = item.rootFolderId == null || item.rootFolderId === "" ? null : Number(item.rootFolderId);
    if (!service || !accountId) throw new HttpError(400, "サービス連携を確認してください。");
    if (service !== "cloud" && rootFolderId !== null) throw new HttpError(400, "日記・請求書の連携にT-Cloudフォルダは指定できません。");
    const integration = serviceProvider(env, service);
    const description = await integration.describeAccount({ accountId, rootFolderId, selectableOnly: true });
    if (!description?.valid) throw new HttpError(400, `${service}の連携先を確認できません。`);
    if (service === "cloud" && accountId !== "folder-member") throw new HttpError(403, "T-Cloud管理者・副管理者は通常のサービス連携から付与できません。");
    const target = publicServiceTarget(service, description);
    if (!target || target.accountId !== accountId || Number(target.rootFolderId || 0) !== Number(rootFolderId || 0)) {
      throw new HttpError(400, `${SERVICE_REGISTRY[service].displayName}の連携先を再確認してください。`);
    }
    if (target.privileged) requireFreshSecurityAdmin(admin);
    links.push({ service, ...target });
  }
  assertUniqueServiceLinks(links);
  await assertExclusiveServiceLinksAvailable(env, identityId, links);
  return links;
}

function insertServiceLinkStatement(env, identityId, link, status = "pending") {
  return env.DB.prepare(`INSERT INTO security_service_links
    (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), identityId, link.service, link.accountId, link.rootFolderId, link.displayLabel, status);
}

function serviceProvider(env, service) {
  const descriptor = SERVICE_REGISTRY[service];
  const provider = descriptor ? env[descriptor.binding] : null;
  if (!provider) throw new HttpError(503, "サービス連携の確認機能を利用できません。");
  return provider;
}

function publicServiceTarget(service, input) {
  const accountId = normalizeText(input?.accountId, 100);
  const displayLabel = normalizeText(input?.displayLabel, 160);
  const role = normalizeText(input?.role, 80);
  const roleLabel = normalizeText(input?.roleLabel, 80);
  const rootFolderId = input?.rootFolderId == null ? null : Number(input.rootFolderId);
  if (!accountId || !displayLabel || !role || (service === "cloud" && (!Number.isSafeInteger(rootFolderId) || rootFolderId <= 0))) return null;
  if (service !== "cloud" && rootFolderId !== null) return null;
  return {
    accountId, rootFolderId, displayLabel, role, roleLabel: roleLabel || role,
    scopeLabel: normalizeText(input?.scopeLabel, 200) || null,
    privileged: Boolean(input?.privileged), exclusive: Boolean(input?.exclusive), shared: Boolean(input?.shared)
  };
}

async function assertExclusiveServiceLinksAvailable(env, identityId, links) {
  for (const link of links.filter((item) => item.exclusive)) {
    if (identityId === PRIMARY_ADMIN_ID && link.service === "diary" && link.accountId === "main-user") continue;
    const existing = await env.DB.prepare(`SELECT identity_id FROM security_service_links
      WHERE service = ? AND service_account_id = ? AND status IN ('pending', 'active')
        AND (? IS NULL OR identity_id != ?) LIMIT 1`)
      .bind(link.service, link.accountId, identityId, identityId).first();
    if (existing) throw new HttpError(409, `${link.displayLabel}は別のユーザーへ既に連携されています。`);
  }
}

function requireFreshSecurityAdmin(admin) {
  if (!admin || !Number.isInteger(Number(admin.authenticatedAt)) || nowSeconds() - Number(admin.authenticatedAt) > PRIVILEGED_LINK_REAUTH_SECONDS) {
    throw new HttpError(428, "特権アカウントを追加する前に、管理者の端末ロック解除をもう一度行ってください。");
  }
}

function serviceLinkKey(link) {
  return `${link.service}\u0000${link.accountId}\u0000${link.rootFolderId == null ? "" : Number(link.rootFolderId)}`;
}

function isPrimaryAdminCoreLink(link) {
  return PRIMARY_ADMIN_CORE_LINKS.has(serviceLinkKey({
    service: link.service,
    accountId: link.service_account_id ?? link.accountId,
    rootFolderId: link.cloud_root_folder_id ?? link.rootFolderId ?? null
  }));
}

function assertUniqueServiceLinks(links) {
  const keys = links.map(serviceLinkKey);
  if (new Set(keys).size !== keys.length) throw new HttpError(409, "同じサービス連携が重複しています。");
}

async function ensurePrimaryAdminRecords(env) {
  await env.DB.prepare(`INSERT INTO security_identities (id, display_name, status, is_security_admin)
    VALUES (?, '第一管理者', 'invited', 1) ON CONFLICT(id) DO NOTHING`).bind(PRIMARY_ADMIN_ID).run();
  const defaults = [
    { service: "cloud", accountId: "admin", rootFolderId: null, displayLabel: "T-Cloud 管理者" },
    { service: "cloud", accountId: "subadmin", rootFolderId: null, displayLabel: "T-Cloud 副管理者" },
    { service: "diary", accountId: "main-admin", rootFolderId: null, displayLabel: "日記 管理者" },
    { service: "diary", accountId: "main-user", rootFolderId: null, displayLabel: "田中宏知（一般ユーザー）" },
    { service: "billing", accountId: "owner", rootFolderId: null, displayLabel: "請求書 owner" }
  ];
  for (const link of defaults) {
    const existing = await env.DB.prepare(`SELECT id FROM security_service_links
      WHERE identity_id = ? AND service = ? AND service_account_id = ?
        AND cloud_root_folder_id IS NULL AND status IN ('pending', 'active') LIMIT 1`).bind(PRIMARY_ADMIN_ID, link.service, link.accountId).first();
    if (existing) continue;
    await env.DB.prepare(`INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
      .bind(crypto.randomUUID(), PRIMARY_ADMIN_ID, link.service, link.accountId, link.rootFolderId, link.displayLabel).run();
  }
}

async function hasSecurityAdmin(env) {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM security_identities i WHERE i.is_security_admin = 1 AND i.status = 'active' AND EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'active') LIMIT 1").first();
  return Boolean(row);
}

async function enforceBootstrapAttemptLimit(request, env) {
  const hash = await sourceHash(request, env);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS attempts FROM security_audit_events
    WHERE event_type = 'bootstrap_auth_failure' AND source_hash = ?
      AND occurred_at >= ?`).bind(hash, bootstrapAttemptCutoff()).first();
  if (Number(recent?.attempts || 0) >= 5) {
    await writeLocalAudit(env, { eventType: "bootstrap_login_blocked", outcome: "blocked", authMethod: "password", serviceAccountId: "admin" }, request);
    throw new HttpError(429, "管理者確認が一時停止されています。15分ほど待ってからお試しください。");
  }
}

async function enforceAuthenticationOptionsRateLimit(request, env) {
  const hash = await sourceHash(request, env);
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS attempts FROM security_audit_events
    WHERE event_type = 'passkey_authentication_options' AND source_hash = ? AND occurred_at >= ?`)
    .bind(hash, since).first();
  if (Number(recent?.attempts || 0) >= 20) {
    throw new HttpError(429, "端末のロック解除の開始回数が多すぎます。5分ほど待ってからお試しください。");
  }
}

async function requireSecurityAdmin(request, env) {
  const session = await activeSecurityAdminSession(request, env);
  if (!session) throw new HttpError(401, "Security Centerの管理者認証が必要です。");
  return session;
}

async function activeSecurityAdminSession(request, env) {
  const session = await readSecuritySession(request, env, ADMIN_COOKIE, "admin");
  if (!session) return null;
  const identity = await env.DB.prepare(`SELECT i.id FROM security_identities i
    JOIN security_credentials c ON c.identity_id = i.id
    WHERE i.id = ? AND i.is_security_admin = 1 AND i.status = 'active'
      AND c.credential_id = ? AND c.status = 'active'`).bind(session.identityId, session.credentialId).first();
  return identity ? session : null;
}

async function requireIdentitySession(request, env) {
  const session = await readSecuritySession(request, env, IDENTITY_COOKIE, "identity");
  if (!session) throw new HttpError(401, "パスキー認証をもう一度行ってください。");
  const credential = await env.DB.prepare(`SELECT 1 AS ok FROM security_credentials
    WHERE credential_id = ? AND identity_id = ? AND status != 'revoked'`)
    .bind(session.credentialId, session.identityId).first();
  if (!credential) throw new HttpError(401, "パスキー認証をもう一度行ってください。");
  return session;
}

async function requireSetupOrIdentitySession(request, env) {
  const setup = await readSetupSession(request, env);
  if (setup) return { identityId: setup.identity_id, credentialId: setup.credential_id, setupId: setup.id };
  return requireIdentitySession(request, env);
}

async function requireSetupSession(request, env) {
  const setup = await readSetupSession(request, env);
  if (!setup) throw new HttpError(401, "T-Cloudの準備セッションが終了しました。パスキー登録または復旧登録をやり直してください。");
  return { ...setup, identityId: setup.identity_id, credentialId: setup.credential_id, setupId: setup.id };
}

async function readSetupSession(request, env, allowedStatuses = ["active"]) {
  try {
    const token = parseCookies(request.headers.get("Cookie") || "")[SETUP_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
    const statuses = allowedStatuses.filter((status) => ["active", "completed"].includes(status));
    if (!statuses.length) return null;
    const placeholders = statuses.map(() => "?").join(", ");
    return env.DB.prepare(`SELECT s.* FROM security_setup_sessions s
      JOIN security_credentials c ON c.credential_id = s.credential_id AND c.identity_id = s.identity_id
      JOIN security_identities i ON i.id = s.identity_id
      WHERE s.token_hash = ? AND s.status IN (${placeholders}) AND s.expires_at > ?
        AND c.status != 'revoked' AND i.status != 'disabled'`)
      .bind(await sha256(token), ...statuses, nowSeconds()).first();
  } catch {
    return null;
  }
}

async function prepareSetupSession(env, identityId, credentialId) {
  const token = randomToken(32);
  return { id: crypto.randomUUID(), token, tokenHash: await sha256(token), identityId, credentialId, expiresAt: nowSeconds() + SETUP_TTL_SECONDS };
}

function insertSetupSessionStatement(env, setup) {
  return env.DB.prepare(`INSERT INTO security_setup_sessions
    (id, token_hash, identity_id, credential_id, expires_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(setup.id, setup.tokenHash, setup.identityId, setup.credentialId, setup.expiresAt);
}

async function requireActiveIdentitySession(request, env) {
  const session = await requireIdentitySession(request, env);
  const active = await env.DB.prepare(`SELECT 1 AS ok FROM security_credentials c
    JOIN security_identities i ON i.id = c.identity_id
    WHERE c.credential_id = ? AND c.identity_id = ? AND c.status = 'active' AND i.status = 'active'`)
    .bind(session.credentialId, session.identityId).first();
  if (!active) throw new HttpError(403, "このパスキーは管理者の承認待ちです。");
  return session;
}

async function securitySessionHeaders(env, url, identityId, credentialId, admin) {
  const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
  if (!runtime.enabled) throw new HttpError(503, "パスキー機能は一時停止中です。");
  const headers = new Headers();
  const authenticatedAt = nowSeconds();
  const sessionId = crypto.randomUUID();
  const identityTtl = clampNumber(env.IDENTITY_SESSION_TTL_SECONDS, 60, 900, 600);
  headers.append("Set-Cookie", await signedCookie(env, IDENTITY_COOKIE, { kind: "identity", identityId, credentialId, passkeySessionEpoch: runtime.epoch, authenticatedAt, sessionId }, identityTtl, url.protocol === "https:"));
  if (admin) {
    const adminTtl = clampNumber(env.ADMIN_SESSION_TTL_SECONDS, 300, 7200, 3600);
    headers.append("Set-Cookie", await signedCookie(env, ADMIN_COOKIE, { kind: "admin", identityId, credentialId, passkeySessionEpoch: runtime.epoch, authenticatedAt, sessionId }, adminTtl, url.protocol === "https:"));
  }
  return headers;
}

async function signedCookie(env, name, payload, ttl, secureValue) {
  if (!env.SESSION_SECRET) throw new HttpError(503, "Security Centerのセッション設定が完了していません。");
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify({ ...payload, exp: nowSeconds() + ttl })));
  const token = `${encoded}.${await hmac(encoded, env.SESSION_SECRET)}`;
  return `${name}=${token}; Path=${BASE_PATH}; Max-Age=${ttl}; HttpOnly; SameSite=Strict${secureValue ? "; Secure" : ""}`;
}

async function readSecuritySession(request, env, name, expectedKind) {
  try {
    const runtime = await observePasskeyRuntime(env, passkeysEnabled(env));
    if (!runtime.enabled) return null;
    const token = parseCookies(request.headers.get("Cookie") || "")[name];
    if (!token || !env.SESSION_SECRET) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature || !(await safeEqual(signature, await hmac(payload, env.SESSION_SECRET)))) return null;
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return value.kind === expectedKind && value.exp > nowSeconds()
      && Number.isInteger(Number(value.passkeySessionEpoch))
      && Number(value.passkeySessionEpoch) === runtime.epoch ? value : null;
  } catch { return null; }
}

async function tcloudEnvelopeBundle(env, identityId, credentialId, linkId, accountId) {
  if (accountId === "subadmin") return {};
  const [result, vault] = await Promise.all([
    env.DB.prepare(`SELECT envelope_type, public_key_jwk, encrypted_payload, payload_iv, wrapped_key
      FROM security_tcloud_key_envelopes
      WHERE identity_id = ? AND credential_id = ? AND service_link_id = ? AND envelope_type = ?`)
      .bind(identityId, credentialId, linkId, accountId === "admin" ? "admin_private_prf" : "folder_key_rsa").all(),
    accountId === "folder-member"
      ? env.DB.prepare("SELECT public_key_jwk, encrypted_payload, payload_iv FROM security_tcloud_client_vaults WHERE identity_id = ? AND credential_id = ?").bind(identityId, credentialId).first()
      : null
  ]);
  const bundle = Object.fromEntries((result.results || []).map((row) => [row.envelope_type, {
    publicKeyJwk: row.public_key_jwk ? parseJson(row.public_key_jwk, null) : null,
    encryptedPayload: row.encrypted_payload || null, payloadIv: row.payload_iv || null, wrappedKey: row.wrapped_key || null
  }]));
  if (vault) bundle.client_private_prf = { publicKeyJwk: parseJson(vault.public_key_jwk, null), encryptedPayload: vault.encrypted_payload, payloadIv: vault.payload_iv, wrappedKey: null };
  return bundle;
}

async function storeAuditEvent(env, input) {
  const event = normalizeAuditEvent(input);
  let link = null;
  if (event.serviceLinkId) {
    link = await env.DB.prepare(`SELECT id, identity_id, service, service_account_id, cloud_root_folder_id, display_label
      FROM security_service_links WHERE id = ? AND service = ? LIMIT 1`).bind(event.serviceLinkId, event.service).first();
    if (link && (!event.serviceAccountId || link.service_account_id === event.serviceAccountId)) {
      event.identityId ||= link.identity_id;
      event.serviceAccountId ||= link.service_account_id;
      event.serviceAccountLabel = link.display_label;
    } else {
      link = null;
      event.serviceLinkId = null;
    }
  }
  if (!event.identityId && event.serviceAccountId && event.service !== "security") {
    const identities = await env.DB.prepare(`SELECT identity_id FROM security_service_links
      WHERE service = ? AND service_account_id = ? AND status = 'active'
      GROUP BY identity_id ORDER BY identity_id LIMIT 2`).bind(event.service, event.serviceAccountId).all();
    if ((identities.results || []).length === 1) {
      link = await env.DB.prepare(`SELECT id, identity_id, display_label, cloud_root_folder_id FROM security_service_links
        WHERE identity_id = ? AND service = ? AND service_account_id = ? AND status = 'active'
        ORDER BY created_at, id LIMIT 1`)
        .bind(identities.results[0].identity_id, event.service, event.serviceAccountId).first();
      event.identityId = link.identity_id;
      event.serviceLinkId ||= link.id;
      event.serviceAccountLabel = link.display_label;
    }
  }
  if (!event.serviceAccountLabel && event.service === "security") {
    event.serviceAccountLabel = event.role === "security-admin" ? "Security Center 管理者" : "Security Center 利用者";
  }
  if (!event.serviceAccountLabel && event.serviceAccountId && event.service !== "security") {
    try {
      const described = await serviceProvider(env, event.service).describeAccount({
        accountId: event.serviceAccountId,
        rootFolderId: link?.cloud_root_folder_id ?? event.details.rootFolderId ?? null
      });
      if (described?.valid) event.serviceAccountLabel = normalizeText(described.displayLabel, 160) || null;
    } catch { /* audit ingestion must not fail solely because a provider is unavailable */ }
  }
  const statements = [auditInsertStatement(env, event), ...identityActivityStatements(env, event)];
  await env.DB.batch(statements);
}

async function writeLocalAudit(env, input, request = null) {
  const event = await localAuditEvent(env, input, request);
  await env.DB.batch([auditInsertStatement(env, event), ...identityActivityStatements(env, event)]);
}

async function recordSecuritySessionResume(env, request, session) {
  const identifier = session.sessionId || `${session.kind}:${session.identityId}:${session.credentialId}:${session.exp}`;
  return storeAuditEvent(env, {
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    service: "security",
    eventType: "session_resume",
    outcome: "success",
    identityId: session.identityId,
    serviceAccountId: session.kind === "admin" ? "security-admin" : "security-identity",
    role: session.kind === "admin" ? "security-admin" : "identity",
    authMethod: "passkey",
    sessionIdHash: await hmac(identifier, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit"),
    sourceHash: await sourceHash(request, env),
    userAgent: request.headers.get("User-Agent") || null
  });
}

function scheduleAudit(context, promise) {
  const task = Promise.resolve(promise).catch((error) => console.error("Security session audit failed", safeErrorName(error)));
  if (context?.waitUntil) context.waitUntil(task);
}

async function localAuditStatement(env, input, request = null) {
  return auditInsertStatement(env, await localAuditEvent(env, input, request));
}

async function localAuditEvent(env, input, request = null) {
  return normalizeAuditEvent({
    eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), service: input.service || "security",
    eventType: input.eventType, outcome: input.outcome || "info", identityId: input.identityId || null,
    serviceLinkId: input.serviceLinkId || null, serviceAccountId: input.serviceAccountId || null,
    serviceAccountLabel: input.serviceAccountLabel || null, role: input.role || null,
    authMethod: input.authMethod || "system", sourceHash: request ? await sourceHash(request, env) : null,
    userAgent: request?.headers.get("User-Agent") || null, details: input.details || {}
  });
}

function auditInsertStatement(env, event) {
  const conflict = event.eventType === "session_resume"
    ? "ON CONFLICT DO NOTHING"
    : "ON CONFLICT(event_id) DO NOTHING";
  return env.DB.prepare(`INSERT INTO security_audit_events
    (event_id, occurred_at, service, event_type, outcome, identity_id, service_link_id, service_account_id,
      service_account_label, role, auth_method, session_id_hash, source_hash, user_agent, target_type, target_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ${conflict}`)
    .bind(event.eventId, event.occurredAt, event.service, event.eventType, event.outcome, event.identityId,
      event.serviceLinkId, event.serviceAccountId, event.serviceAccountLabel, event.role, event.authMethod,
      event.sessionIdHash, event.sourceHash, event.userAgent, event.targetType, event.targetId, JSON.stringify(event.details));
}

function identityActivityStatements(env, event) {
  if (!event.identityId || event.outcome !== "success") return [];
  if (LOGIN_SUCCESS_EVENTS.includes(event.eventType)) {
    return [env.DB.prepare(`UPDATE security_identities SET
      last_login_at = CASE WHEN last_login_at IS NULL OR last_login_at < ? THEN ? ELSE last_login_at END,
      last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (
        last_login_at IS NULL OR last_login_at < ? OR last_seen_at IS NULL OR last_seen_at < ?
      )`).bind(event.occurredAt, event.occurredAt, event.occurredAt, event.occurredAt,
        event.identityId, event.occurredAt, event.occurredAt)];
  }
  if (event.eventType === "session_resume") {
    return [env.DB.prepare(`UPDATE security_identities SET last_seen_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`)
      .bind(event.occurredAt, event.identityId, event.occurredAt)];
  }
  return [];
}

function normalizeAuditEvent(input) {
  const service = ["security", "cloud", "diary", "billing"].includes(input?.service) ? input.service : "security";
  const outcome = ["success", "failure", "blocked", "cancelled", "info"].includes(input?.outcome) ? input.outcome : "info";
  const authMethod = ["password", "passkey", "system"].includes(input?.authMethod) ? input.authMethod : null;
  return {
    eventId: normalizeId(input?.eventId) || crypto.randomUUID(), occurredAt: validIso(input?.occurredAt) || new Date().toISOString(),
    service, eventType: normalizeText(input?.eventType, 80) || "unknown", outcome,
    identityId: normalizeIdentityId(input?.identityId) || null, serviceLinkId: normalizeId(input?.serviceLinkId) || null,
    serviceAccountId: normalizeText(input?.serviceAccountId, 100) || null,
    serviceAccountLabel: normalizeText(input?.serviceAccountLabel, 160) || null,
    role: normalizeText(input?.role, 80) || null, authMethod,
    sessionIdHash: normalizeSecretText(input?.sessionIdHash, 128) || null, sourceHash: normalizeSecretText(input?.sourceHash, 128) || null,
    userAgent: normalizeText(input?.userAgent, 300) || null, targetType: normalizeText(input?.targetType, 80) || null,
    targetId: normalizeText(input?.targetId, 160) || null, details: sanitizeDetails(input?.details)
  };
}

function sanitizeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const forbidden = /password|secret|token|cookie|proof|key|content|title|body|recovery/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).slice(0, 20).map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 200) : (typeof item === "number" || typeof item === "boolean" ? item : null)]));
}

async function sourceHash(request, env) {
  const source = request.headers.get("CF-Connecting-IP") || "local";
  return hmac(source, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit");
}

async function serveAsset(request, env, url, path) {
  const assetPath = path === "/" || path === "/invite" ? "/" : path;
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", assetPath === "/" ? "no-store" : "no-cache");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireMutation(request, url) {
  if (request.headers.get("Origin") !== url.origin || !String(request.headers.get("Content-Type") || "").startsWith("application/json")) {
    throw new HttpError(403, "不正なリクエストです。");
  }
}

async function publicLink(env, row) {
  let description = null;
  try { description = await serviceProvider(env, row.service).describeAccount({ accountId: row.service_account_id, rootFolderId: row.cloud_root_folder_id }); }
  catch { /* the stored server-validated label remains a safe fallback */ }
  return {
    id: row.id,
    service: row.service,
    accountId: row.service_account_id,
    rootFolderId: row.cloud_root_folder_id == null ? null : Number(row.cloud_root_folder_id),
    displayLabel: normalizeText(description?.displayLabel, 160) || row.display_label,
    role: normalizeText(description?.role, 80) || null,
    roleLabel: normalizeText(description?.roleLabel, 80) || null,
    scopeLabel: normalizeText(description?.scopeLabel, 200) || null
  };
}

function passkeysEnabled(env) { return String(env.PASSKEY_ENABLED || "false") === "true"; }
async function observePasskeyRuntime(env, requestedEnabled) {
  await env.DB.prepare(`INSERT INTO security_runtime_state (id, passkey_session_epoch, switch_observed_enabled)
    VALUES (1, 1, 1) ON CONFLICT(id) DO NOTHING`).run();
  if (!requestedEnabled) {
    await env.DB.prepare(`UPDATE security_runtime_state
      SET passkey_session_epoch = passkey_session_epoch + 1, switch_observed_enabled = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND switch_observed_enabled = 1`).run();
  }
  const state = await env.DB.prepare("SELECT passkey_session_epoch, switch_observed_enabled FROM security_runtime_state WHERE id = 1").first();
  return {
    enabled: Boolean(requestedEnabled) && Number(state?.switch_observed_enabled) === 1,
    epoch: Number(state?.passkey_session_epoch || 1)
  };
}
function rpId(env) { return env.RP_ID || "tanaka-note.com"; }
function expectedOrigins(env) { return String(env.EXPECTED_ORIGIN || "https://tanaka-note.com").split(",").map((value) => value.trim()).filter(Boolean).concat(env.ALLOW_LOCAL_HTTP === "true" ? ["http://127.0.0.1:8790", "http://localhost:8790"] : []); }
function normalizeService(value) { return normalizeLinkedService(value); }
function normalizeAuthService(value) { return normalizeAuditService(value); }
function normalizeId(value) { const text = String(value || "").trim(); return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : ""; }
function normalizeText(value, max) { return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : ""; }
function normalizeSecretText(value, max) { const text = typeof value === "string" ? value.trim() : ""; return text.length <= max ? text : ""; }
function validIso(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }
function randomToken(bytes) { const value = crypto.getRandomValues(new Uint8Array(bytes)); return bytesToBase64Url(value); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function validatePublicJwk(value) { if (!value || value.kty !== "RSA" || value.alg !== "RSA-OAEP-256" || !value.n || !value.e || "d" in value) throw new HttpError(400, "公開鍵を確認してください。"); return { kty: "RSA", alg: "RSA-OAEP-256", key_ops: ["encrypt"], ext: true, n: value.n, e: value.e }; }
function canonicalJwk(value) { const jwk = validatePublicJwk(value); return JSON.stringify({ alg: jwk.alg, e: jwk.e, ext: true, key_ops: ["encrypt"], kty: jwk.kty, n: jwk.n }); }
function withUtcTimes(row) { const result = { ...row }; for (const key of Object.keys(result)) if (key.endsWith("_at") && result[key] != null) result[key] = normalizeUtcTimestamp(result[key]); return result; }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; })); }
function clearCookie(name, secureValue) { return `${name}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secureValue ? "; Secure" : ""}`; }
function setupCookie(token, secureValue) { return `${SETUP_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${SETUP_TTL_SECONDS}; HttpOnly; SameSite=Strict${secureValue ? "; Secure" : ""}`; }
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const length = Number(request.headers.get("Content-Length") || 0); if (length > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const body = await request.json(); return body && typeof body === "object" ? body : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
async function sha256(value) { return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))))); }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function safeEqual(left, right) { const a = base64UrlToBytes(left); const b = base64UrlToBytes(right); if (a.length !== b.length) return false; let result = 0; for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index]; return result === 0; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(value) { const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "="); return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); }

function prfAuthenticationExtensions(credentials) {
  return {
    prf: {
      evalByCredential: Object.fromEntries(credentials.map((credential) => [
        credential.credential_id,
        { first: canonicalBase64Url(credential.prf_salt) }
      ]))
    }
  };
}

function canonicalBase64Url(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw new Error("Stored WebAuthn PRF salt is invalid");
  }
  try {
    const bytes = base64UrlToBytes(text);
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (!bytes.length || canonical !== text) throw new Error("non-canonical");
    return text;
  } catch {
    throw new Error("Stored WebAuthn PRF salt is invalid");
  }
}
function safeErrorName(error) { return error instanceof Error ? `${error.name}:${String(error.message || "").slice(0, 160)}` : "unknown"; }
function safeClientErrorMessage(value, status = 400) {
  const text = String(value || "").trim();
  if (text && /[\u3040-\u30ff\u3400-\u9fff]/.test(text)
    && !/\b(?:InvalidStateError|NotAllowedError|AbortError|NotSupportedError|SecurityError|ConstraintError|UnknownError|OperationError|DataError|TypeError|DOMException|WebAssembly|non-canonical)\b/i.test(text)) return text;
  if (status === 404) return "指定された情報が見つかりません。";
  return "リクエストを処理できませんでした。入力内容を確認して、もう一度お試しください。";
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

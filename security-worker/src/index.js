import { WorkerEntrypoint } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

const BASE_PATH = "/security";
const ADMIN_COOKIE = "troom_security_admin";
const IDENTITY_COOKIE = "troom_security_identity";
const PRIMARY_ADMIN_ID = "primary-admin";
const CHALLENGE_TTL_SECONDS = 5 * 60;
const HANDOFF_TTL_SECONDS = 60;
const INVITE_DEFAULT_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default class SecurityWorker extends WorkerEntrypoint {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === BASE_PATH) return secure(Response.redirect(`${url.origin}${BASE_PATH}/`, 308));
      if (!url.pathname.startsWith(BASE_PATH)) return secure(new Response("Not found", { status: 404 }));
      const path = url.pathname.slice(BASE_PATH.length) || "/";
      if (path.startsWith("/api/")) return secure(await handleApi(request, this.env, url, path));
      return secure(await serveAsset(request, this.env, url, path));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Security Center request failed", safeErrorName(error));
      return secure(json({ error: status === 500 ? "Security Centerで処理を完了できませんでした。" : error.message }, status));
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
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM security_challenges WHERE expires_at < ?").bind(nowSeconds() - 86400),
      this.env.DB.prepare("DELETE FROM security_handoffs WHERE expires_at < ?").bind(nowSeconds() - 86400),
      this.env.DB.prepare("UPDATE security_invitations SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").bind(nowSeconds()),
      this.env.DB.prepare("DELETE FROM security_audit_events WHERE occurred_at < datetime('now', ?)").bind(`-${retentionDays} days`)
    ]);
  }

  async redeemHandoff(token, service) {
    return redeemHandoff(this.env, token, service);
  }
}

async function handleApi(request, env, url, path) {
  if (path === "/api/status" && request.method === "GET") {
    const initialized = await hasSecurityAdmin(env);
    const admin = await readSecuritySession(request, env, ADMIN_COOKIE, "admin");
    return json({ enabled: passkeysEnabled(env), initialized, adminAuthenticated: Boolean(admin) });
  }

  if (!passkeysEnabled(env)) throw new HttpError(503, "パスキー機能は一時停止中です。従来のID・パスワードでログインしてください。");

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
    return prfVerify(request, env);
  }
  if (path === "/api/tcloud/envelope" && request.method === "POST") {
    requireMutation(request, url);
    return saveOwnTCloudEnvelope(request, env);
  }
  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    const headers = new Headers();
    headers.append("Set-Cookie", clearCookie(ADMIN_COOKIE, url.protocol === "https:"));
    headers.append("Set-Cookie", clearCookie(IDENTITY_COOKIE, url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const admin = await requireSecurityAdmin(request, env);
  if (path === "/api/dashboard" && request.method === "GET") return dashboard(env);
  if (path === "/api/identities" && request.method === "GET") return listIdentities(env);
  if (path === "/api/identities" && request.method === "POST") {
    requireMutation(request, url);
    return createIdentityAndInvite(request, env, admin);
  }
  if (path === "/api/audit" && request.method === "GET") return listAuditEvents(url, env);

  const identityMatch = path.match(/^\/api\/identities\/([a-zA-Z0-9-]{1,64})$/);
  if (identityMatch && request.method === "GET") return identityDetail(identityMatch[1], env);
  const addLinkMatch = path.match(/^\/api\/identities\/([a-zA-Z0-9-]{1,64})\/links$/);
  if (addLinkMatch && request.method === "POST") {
    requireMutation(request, url);
    return addIdentityLinks(addLinkMatch[1], request, env, admin);
  }
  const removeLinkMatch = path.match(/^\/api\/service-links\/([a-zA-Z0-9-]{1,64})$/);
  if (removeLinkMatch && request.method === "POST") {
    requireMutation(request, url);
    return removeIdentityLink(removeLinkMatch[1], request, env, admin);
  }
  const approveMatch = path.match(/^\/api\/identities\/([a-zA-Z0-9-]{1,64})\/approve$/);
  if (approveMatch && request.method === "POST") {
    requireMutation(request, url);
    return approveIdentity(approveMatch[1], request, env, admin);
  }
  const reinviteMatch = path.match(/^\/api\/identities\/([a-zA-Z0-9-]{1,64})\/reinvite$/);
  if (reinviteMatch && request.method === "POST") {
    requireMutation(request, url);
    return reinviteIdentity(reinviteMatch[1], request, env, admin);
  }
  const credentialRevokeMatch = path.match(/^\/api\/credentials\/([A-Za-z0-9_-]{16,1024})\/revoke$/);
  if (credentialRevokeMatch && request.method === "POST") {
    requireMutation(request, url);
    return revokeCredential(credentialRevokeMatch[1], env, admin);
  }
  const inviteRevokeMatch = path.match(/^\/api\/invitations\/([a-zA-Z0-9-]{1,64})\/revoke$/);
  if (inviteRevokeMatch && request.method === "POST") {
    requireMutation(request, url);
    return revokeInvitation(inviteRevokeMatch[1], env, admin);
  }
  throw new HttpError(404, "Not found");
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
  const prfSalt = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO security_credentials
      (credential_id, identity_id, public_key, counter, transports_json, device_type, backed_up, prf_enabled, prf_salt, status, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`)
      .bind(credential.id, PRIMARY_ADMIN_ID, bytesToBase64Url(credential.publicKey), Number(credential.counter || 0),
        JSON.stringify(credential.transports || []), verification.registrationInfo.credentialDeviceType,
        verification.registrationInfo.credentialBackedUp ? 1 : 0, body.prfEnabled ? 1 : 0, prfSalt),
    env.DB.prepare("UPDATE security_identities SET status = 'active', is_security_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(PRIMARY_ADMIN_ID),
    env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ?").bind(PRIMARY_ADMIN_ID)
  ]);
  await writeLocalAudit(env, { eventType: "passkey_registration", outcome: "success", identityId: PRIMARY_ADMIN_ID, authMethod: "passkey", serviceAccountId: "admin" }, request);
  const headers = await securitySessionHeaders(env, url, PRIMARY_ADMIN_ID, credential.id, true);
  return json({ ok: true, identityId: PRIMARY_ADMIN_ID, credentialId: credential.id, prfSalt, prfEnabled: Boolean(body.prfEnabled), needsTCloudEnvelope: true }, 201, headers);
}

async function invitationOptions(request, env) {
  const body = await readJson(request, 8192);
  const token = normalizeSecretText(body.token, 512);
  const invitation = await requireUsableInvitation(env, token);
  const identity = await env.DB.prepare("SELECT id, display_name FROM security_identities WHERE id = ?").bind(invitation.identity_id).first();
  const existing = await env.DB.prepare("SELECT credential_id AS id, transports_json AS transports FROM security_credentials WHERE identity_id = ? AND status != 'revoked'").bind(identity.id).all();
  const options = await registrationOptions(env, identity.id, identity.display_name, (existing.results || []).map((row) => ({ id: row.id, transports: parseJson(row.transports, []) })));
  const challengeId = await storeChallenge(env, "invite_registration", options.challenge, identity.id, invitation.id, null);
  const cloudLink = await env.DB.prepare("SELECT id, service_account_id, cloud_root_folder_id FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND status IN ('pending', 'active') LIMIT 1").bind(identity.id).first();
  return json({ challengeId, identity: { id: identity.id, displayName: identity.display_name }, options, cloudLink: cloudLink ? { id: cloudLink.id, accountId: cloudLink.service_account_id, rootFolderId: cloudLink.cloud_root_folder_id } : null });
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
  const prfSalt = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO security_credentials
      (credential_id, identity_id, public_key, counter, transports_json, device_type, backed_up, prf_enabled, prf_salt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .bind(credential.id, invitation.identity_id, bytesToBase64Url(credential.publicKey), Number(credential.counter || 0),
        JSON.stringify(credential.transports || []), verification.registrationInfo.credentialDeviceType,
        verification.registrationInfo.credentialBackedUp ? 1 : 0, body.prfEnabled ? 1 : 0, prfSalt),
    env.DB.prepare("UPDATE security_invitations SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(invitation.id),
    env.DB.prepare("UPDATE security_identities SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending_approval' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invitation.identity_id)
  ]);
  await writeLocalAudit(env, { eventType: "invite_used", outcome: "success", identityId: invitation.identity_id, authMethod: "passkey" }, request);
  await writeLocalAudit(env, { eventType: "passkey_registration", outcome: "success", identityId: invitation.identity_id, authMethod: "passkey" }, request);
  const headers = await securitySessionHeaders(env, url, invitation.identity_id, credential.id, false);
  return json({ ok: true, pendingApproval: true, identityId: invitation.identity_id, credentialId: credential.id, prfSalt, prfEnabled: Boolean(body.prfEnabled) }, 201, headers);
}

async function authenticationOptions(request, env) {
  const body = await readJson(request, 4096);
  const service = normalizeAuthService(body.service);
  if (!service) throw new HttpError(400, "ログイン先サービスを確認してください。");
  const servicePredicate = service === "security"
    ? "i.is_security_admin = 1"
    : "EXISTS (SELECT 1 FROM security_service_links l WHERE l.identity_id = i.id AND l.service = ? AND l.status = 'active')";
  const statement = env.DB.prepare(`SELECT c.credential_id, c.transports_json, c.prf_salt
    FROM security_credentials c
    JOIN security_identities i ON i.id = c.identity_id
    WHERE c.status = 'active' AND i.status = 'active'
      AND ${servicePredicate}
    ORDER BY c.registered_at ASC`);
  const rows = await (service === "security" ? statement.all() : statement.bind(service).all());
  if (!(rows.results || []).length) throw new HttpError(404, "パスキーが登録されていません。管理者からの招待を確認してください。");
  const evalByCredential = Object.fromEntries(rows.results.map((row) => [row.credential_id, { first: base64UrlToBytes(row.prf_salt) }]));
  const options = await generateAuthenticationOptions({
    rpID: rpId(env), timeout: 60000, userVerification: "required",
    allowCredentials: rows.results.map((row) => ({ id: row.credential_id, transports: parseJson(row.transports_json, []) })),
    extensions: { prf: { evalByCredential } }
  });
  const challengeId = await storeChallenge(env, "authentication", options.challenge, null, null, service);
  return json({ challengeId, options });
}

async function authenticationVerify(request, env, url) {
  const body = await readJson(request, 100000);
  const service = normalizeAuthService(body.service);
  const challenge = await consumeChallenge(env, body.challengeId, "authentication", null);
  if (!service || challenge.service !== service) throw new HttpError(401, "認証先サービスが一致しません。");
  const credentialId = normalizeSecretText(body.response?.id, 2048);
  const credential = await activeCredential(env, credentialId);
  if (!credential) {
    await writeLocalAudit(env, { eventType: "passkey_authentication_failure", outcome: "failure", authMethod: "passkey" }, request);
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
    await writeLocalAudit(env, { eventType: "passkey_authentication_failure", outcome: "failure", identityId: credential.identity_id, authMethod: "passkey" }, request);
    throw new HttpError(401, "パスキーを確認できませんでした。");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE security_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = ?").bind(verification.authenticationInfo.newCounter, credentialId),
    env.DB.prepare("UPDATE security_identities SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(credential.identity_id)
  ]);
  const links = service === "security" ? [] : await activeLinks(env, credential.identity_id, service);
  if (service === "security" && !credential.is_security_admin) throw new HttpError(403, "Security Centerを管理する権限がありません。");
  if (service !== "security" && !links.length) throw new HttpError(403, "このサービスへ接続されたアカウントがありません。");
  await writeLocalAudit(env, { eventType: "passkey_login_success", outcome: "success", identityId: credential.identity_id, authMethod: "passkey", service }, request);
  const headers = await securitySessionHeaders(env, url, credential.identity_id, credentialId, Boolean(credential.is_security_admin));
  return json({ authenticated: true, credentialId, prfSalt: credential.prf_salt, links: links.map(publicLink) }, 200, headers);
}

async function createHandoff(request, env) {
  const identitySession = await requireActiveIdentitySession(request, env);
  const body = await readJson(request, 4096);
  const service = normalizeService(body.service);
  const links = await activeLinks(env, identitySession.identityId, service);
  if (!links.length) throw new HttpError(403, "このサービスへ接続されたアカウントがありません。");
  const selected = body.linkId ? links.find((link) => link.id === body.linkId) : (links.length === 1 ? links[0] : null);
  if (!selected) throw new HttpError(409, "利用するアカウントを選択してください。");
  const envelopes = service === "cloud" ? await tcloudEnvelopeBundle(env, identitySession.identityId, identitySession.credentialId, selected.id) : null;
  if (service === "cloud") {
    const ready = selected.service_account_id === "admin"
      ? Boolean(envelopes.admin_private_prf)
      : Boolean(envelopes.client_private_prf && envelopes.folder_key_rsa);
    if (!ready) throw new HttpError(409, "この端末ではT-Cloudのパスキー復号準備が完了していません。従来のID・パスワードをご利用ください。");
  }
  const rawToken = randomToken(32);
  await env.DB.prepare(`INSERT INTO security_handoffs
    (id, token_hash, identity_id, service_link_id, credential_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), await sha256(rawToken), identitySession.identityId, selected.id, identitySession.credentialId, nowSeconds() + HANDOFF_TTL_SECONDS).run();
  return json({ handoffToken: rawToken, link: publicLink(selected), tcloudKey: envelopes });
}

async function prfOptions(request, env) {
  const identitySession = await requireIdentitySession(request, env);
  const body = await readJson(request, 4096);
  const credentialId = body.credentialId || identitySession.credentialId;
  if (credentialId !== identitySession.credentialId) throw new HttpError(403, "パスキーが一致しません。");
  const credential = await credentialForIdentity(env, credentialId, identitySession.identityId);
  if (!credential) throw new HttpError(404, "パスキーが見つかりません。");
  const options = await generateAuthenticationOptions({
    rpID: rpId(env), timeout: 60000, userVerification: "required",
    allowCredentials: [{ id: credential.credential_id, transports: parseJson(credential.transports_json, []) }],
    extensions: { prf: { evalByCredential: { [credential.credential_id]: { first: base64UrlToBytes(credential.prf_salt) } } } }
  });
  const challengeId = await storeChallenge(env, "prf_assertion", options.challenge, identitySession.identityId, null, null);
  return json({ challengeId, options, credentialId: credential.credential_id, prfSalt: credential.prf_salt });
}

async function prfVerify(request, env) {
  const identitySession = await requireIdentitySession(request, env);
  const body = await readJson(request, 100000);
  const challenge = await consumeChallenge(env, body.challengeId, "prf_assertion", identitySession.identityId);
  const credentialId = normalizeSecretText(body.response?.id, 2048);
  if (credentialId !== identitySession.credentialId) throw new HttpError(403, "パスキーが一致しません。");
  const credential = await credentialForIdentity(env, credentialId, identitySession.identityId);
  const verification = await verifyAuthentication(body.response, challenge.challenge, credential, env);
  if (!verification.verified || !verification.authenticationInfo.userVerified) throw new HttpError(401, "端末のロック解除を確認できませんでした。");
  await env.DB.prepare("UPDATE security_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP, prf_enabled = ? WHERE credential_id = ?")
    .bind(verification.authenticationInfo.newCounter, body.prfAvailable ? 1 : credential.prf_enabled, credentialId).run();
  return json({ verified: true });
}

async function saveOwnTCloudEnvelope(request, env) {
  const identitySession = await requireIdentitySession(request, env);
  const body = await readJson(request, 100000);
  const link = await env.DB.prepare(`SELECT l.*, i.is_security_admin FROM security_service_links l
    JOIN security_identities i ON i.id = l.identity_id
    WHERE l.id = ? AND l.identity_id = ? AND l.service = 'cloud'`)
    .bind(body.serviceLinkId, identitySession.identityId).first();
  if (!link) throw new HttpError(404, "T-Cloud連携が見つかりません。");
  const envelopeType = body.envelopeType === "admin_private_prf" ? body.envelopeType : "client_private_prf";
  if (envelopeType === "admin_private_prf" && (link.service_account_id !== "admin" || !link.is_security_admin)) {
    throw new HttpError(403, "管理者用の暗号鍵envelopeは第一管理者だけが登録できます。");
  }
  if (envelopeType === "client_private_prf" && (link.service_account_id !== "folder-member" || link.cloud_root_folder_id == null)) {
    throw new HttpError(403, "一般ユーザー用のT-Cloud連携を確認してください。");
  }
  const publicKeyJwk = body.publicKeyJwk ? validatePublicJwk(body.publicKeyJwk) : null;
  const encryptedPayload = normalizeSecretText(body.encryptedPayload, 24000);
  const payloadIv = normalizeSecretText(body.payloadIv, 128);
  if (!encryptedPayload || !payloadIv || (envelopeType === "client_private_prf" && !publicKeyJwk)) throw new HttpError(400, "暗号鍵envelopeを確認してください。");
  await env.DB.prepare(`INSERT INTO security_tcloud_key_envelopes
    (id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk, encrypted_payload, payload_iv)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(credential_id, service_link_id, envelope_type) DO UPDATE SET
      public_key_jwk = excluded.public_key_jwk, encrypted_payload = excluded.encrypted_payload,
      payload_iv = excluded.payload_iv, updated_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), identitySession.identityId, identitySession.credentialId, link.id, envelopeType,
      publicKeyJwk ? JSON.stringify(publicKeyJwk) : null, encryptedPayload, payloadIv).run();
  await writeLocalAudit(env, { eventType: "tcloud_key_envelope_saved", outcome: "success", identityId: identitySession.identityId, service: "cloud", authMethod: "passkey" }, request);
  return json({ ok: true });
}

async function dashboard(env) {
  const today = new Date().toISOString().slice(0, 10);
  const counts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN occurred_at >= ? AND event_type LIKE '%login_success%' THEN 1 ELSE 0 END) AS loginSuccess,
    SUM(CASE WHEN occurred_at >= ? AND outcome = 'failure' AND event_type LIKE '%login%' THEN 1 ELSE 0 END) AS loginFailure,
    SUM(CASE WHEN occurred_at >= ? AND outcome = 'blocked' THEN 1 ELSE 0 END) AS lockouts,
    SUM(CASE WHEN occurred_at >= ? AND event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END) AS critical
    FROM security_audit_events`).bind(today, today, today, today).first();
  const identityCounts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'pending') THEN 1 ELSE 0 END) AS pendingApproval,
    SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) AS invited,
    SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'active') THEN 1 ELSE 0 END) AS noPasskey
    FROM security_identities i`).first();
  return json({ loginSuccess: Number(counts?.loginSuccess || 0), loginFailure: Number(counts?.loginFailure || 0), lockouts: Number(counts?.lockouts || 0), critical: Number(counts?.critical || 0), pendingApproval: Number(identityCounts?.pendingApproval || 0), invited: Number(identityCounts?.invited || 0), noPasskey: Number(identityCounts?.noPasskey || 0) });
}

async function listIdentities(env) {
  const result = await env.DB.prepare(`SELECT i.id, i.display_name, i.status, i.is_security_admin, i.last_login_at,
    COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.credential_id END) AS activeCredentials,
    COUNT(DISTINCT CASE WHEN c.status = 'pending' THEN c.credential_id END) AS pendingCredentials,
    MAX(CASE WHEN inv.status = 'active' THEN inv.expires_at END) AS inviteExpiresAt
    FROM security_identities i
    LEFT JOIN security_credentials c ON c.identity_id = i.id
    LEFT JOIN security_invitations inv ON inv.identity_id = i.id
    GROUP BY i.id ORDER BY i.is_security_admin DESC, i.display_name COLLATE NOCASE`).all();
  return json({ identities: (result.results || []).map((row) => ({ id: row.id, displayName: row.display_name, status: row.status, isSecurityAdmin: Boolean(row.is_security_admin), lastLoginAt: row.last_login_at, activeCredentials: Number(row.activeCredentials || 0), pendingCredentials: Number(row.pendingCredentials || 0), inviteExpiresAt: row.inviteExpiresAt ? Number(row.inviteExpiresAt) : null })) });
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
  const pendingCredential = await env.DB.prepare("SELECT credential_id FROM security_credentials WHERE identity_id = ? AND status = 'pending' ORDER BY registered_at DESC LIMIT 1").bind(id).first();
  const clientEnvelope = pendingCredential ? await env.DB.prepare("SELECT public_key_jwk FROM security_tcloud_key_envelopes WHERE identity_id = ? AND credential_id = ? AND envelope_type = 'client_private_prf' LIMIT 1").bind(id, pendingCredential.credential_id).first() : null;
  const adminKeyRows = identity.is_security_admin ? await env.DB.prepare("SELECT credential_id, encrypted_payload, payload_iv FROM security_tcloud_key_envelopes WHERE identity_id = ? AND envelope_type = 'admin_private_prf'").bind(id).all() : { results: [] };
  const cloudFolders = [];
  for (const link of linkRows.filter((item) => item.service === "cloud" && item.cloud_root_folder_id != null)) {
    const folder = await env.CLOUD_AUTH.getFolderCryptoRecord(link.cloud_root_folder_id);
    if (folder) cloudFolders.push({ serviceLinkId: link.id, folder });
  }
  return json({ identity: { id: identity.id, displayName: identity.display_name, status: identity.status, isSecurityAdmin: Boolean(identity.is_security_admin), lastLoginAt: identity.last_login_at }, links: linkRows, credentials: (credentials.results || []).map((row) => ({ ...row, backed_up: Boolean(row.backed_up), prf_enabled: Boolean(row.prf_enabled) })), pendingCredentialId: pendingCredential?.credential_id || null, invitations: invitations.results || [], audits: audits.results || [], cloudApproval: clientEnvelope ? { credentialId: pendingCredential.credential_id, publicKeyJwk: parseJson(clientEnvelope.public_key_jwk, null), folders: cloudFolders } : null, adminKeyEnvelopes: (adminKeyRows.results || []).map((row) => ({ credentialId: row.credential_id, encryptedPayload: row.encrypted_payload, payloadIv: row.payload_iv })) });
}

async function createIdentityAndInvite(request, env, admin) {
  const body = await readJson(request, 20000);
  const displayName = normalizeText(body.displayName, 100);
  const identityId = normalizeId(body.identityId) || crypto.randomUUID();
  if (!displayName) throw new HttpError(400, "表示名を入力してください。");
  const links = await validateServiceLinks(env, body.links);
  if (!links.length) throw new HttpError(400, "少なくとも1つのサービス連携を指定してください。");
  const existing = await env.DB.prepare("SELECT 1 AS ok FROM security_identities WHERE id = ?").bind(identityId).first();
  if (existing) throw new HttpError(409, "同じIdentity IDが既に存在します。");
  await env.DB.prepare("INSERT INTO security_identities (id, display_name, status) VALUES (?, ?, 'invited')").bind(identityId, displayName).run();
  try {
    for (const link of links) await insertServiceLink(env, identityId, link);
    const invitation = await issueInvitation(env, identityId, body.expiresAt, admin.identityId);
    await writeLocalAudit(env, { eventType: "identity_created", outcome: "success", identityId, authMethod: "passkey" }, request);
    await writeLocalAudit(env, { eventType: "invite_created", outcome: "success", identityId, authMethod: "passkey", details: { expiresAt: invitation.expiresAt } }, request);
    return json({ identityId, invitationUrl: `/security/#invite=${encodeURIComponent(invitation.token)}`, expiresAt: invitation.expiresAt }, 201);
  } catch (error) {
    await env.DB.prepare("DELETE FROM security_identities WHERE id = ?").bind(identityId).run();
    throw error;
  }
}

async function addIdentityLinks(identityId, request, env, admin) {
  const identity = await env.DB.prepare("SELECT id FROM security_identities WHERE id = ? AND status != 'disabled'").bind(identityId).first();
  if (!identity) throw new HttpError(404, "Identityが見つかりません。");
  const body = await readJson(request, 20000);
  const links = await validateServiceLinks(env, body.links);
  if (!links.length) throw new HttpError(400, "追加するサービス連携を指定してください。");
  for (const link of links) await insertServiceLink(env, identityId, link);
  await env.DB.prepare("UPDATE security_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(identityId).run();
  await writeLocalAudit(env, { eventType: "service_link_added", outcome: "success", identityId, authMethod: "passkey", details: { changedBy: admin.identityId, count: links.length } }, request);
  return json({ ok: true, requiresReinvite: true });
}

async function removeIdentityLink(linkId, request, env, admin) {
  const link = await env.DB.prepare("SELECT id, identity_id, service, service_account_id FROM security_service_links WHERE id = ?").bind(linkId).first();
  if (!link) throw new HttpError(404, "サービス連携が見つかりません。");
  if (link.identity_id === PRIMARY_ADMIN_ID) throw new HttpError(409, "第一管理者の既定サービス連携は解除できません。");
  await env.DB.prepare("UPDATE security_service_links SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(linkId).run();
  await writeLocalAudit(env, { eventType: "service_link_removed", outcome: "success", identityId: link.identity_id, service: link.service, serviceAccountId: link.service_account_id, authMethod: "passkey", details: { changedBy: admin.identityId } }, request);
  return json({ ok: true });
}

async function approveIdentity(identityId, request, env, admin) {
  const body = await readJson(request, 120000);
  const identity = await env.DB.prepare("SELECT * FROM security_identities WHERE id = ?").bind(identityId).first();
  if (!identity || !["pending_approval", "active"].includes(identity.status)) throw new HttpError(409, "承認待ちのIdentityではありません。");
  const credentialId = normalizeSecretText(body.credentialId, 2048);
  const credential = await env.DB.prepare("SELECT credential_id FROM security_credentials WHERE identity_id = ? AND credential_id = ? AND status = 'pending'")
    .bind(identityId, credentialId).first();
  if (!credential) throw new HttpError(409, "承認待ちのパスキーが見つかりません。");
  const cloudLinks = await env.DB.prepare("SELECT * FROM security_service_links WHERE identity_id = ? AND service = 'cloud' AND status IN ('pending', 'active')").bind(identityId).all();
  let cloudPasskeyReady = !(cloudLinks.results || []).length;
  if ((cloudLinks.results || []).length) {
    const clientEnvelope = await env.DB.prepare("SELECT public_key_jwk FROM security_tcloud_key_envelopes WHERE identity_id = ? AND credential_id = ? AND envelope_type = 'client_private_prf'").bind(identityId, credential?.credential_id || "").first();
    if (clientEnvelope) {
      const delegated = Array.isArray(body.cloudEnvelopes) ? body.cloudEnvelopes : [];
      for (const link of cloudLinks.results) {
        const envelope = delegated.find((item) => item.serviceLinkId === link.id);
        if (!envelope?.wrappedKey) throw new HttpError(400, "T-Cloudフォルダ鍵の安全な委譲が完了していません。");
        const wrappedKey = normalizeSecretText(envelope.wrappedKey, 12000);
        if (!wrappedKey) throw new HttpError(400, "T-Cloudフォルダ鍵の安全な委譲を確認できません。");
        await env.DB.prepare(`INSERT INTO security_tcloud_key_envelopes
          (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
          VALUES (?, ?, ?, ?, 'folder_key_rsa', ?)
          ON CONFLICT(credential_id, service_link_id, envelope_type) DO UPDATE SET
            wrapped_key = excluded.wrapped_key, updated_at = CURRENT_TIMESTAMP`)
          .bind(crypto.randomUUID(), identityId, credential.credential_id, link.id, wrappedKey).run();
      }
      cloudPasskeyReady = true;
    }
  }
  const updates = [
    env.DB.prepare("UPDATE security_credentials SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND credential_id = ? AND status = 'pending'").bind(identityId, credentialId),
    env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND status = 'pending' AND service != 'cloud'").bind(identityId),
    env.DB.prepare("UPDATE security_identities SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(identityId)
  ];
  if (cloudPasskeyReady) updates.push(env.DB.prepare("UPDATE security_service_links SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND status = 'pending' AND service = 'cloud'").bind(identityId));
  await env.DB.batch(updates);
  await writeLocalAudit(env, { eventType: "identity_approved", outcome: "success", identityId, authMethod: "passkey", details: { approvedBy: admin.identityId, tcloudPasskeyReady: cloudPasskeyReady } }, request);
  return json({ ok: true, tcloudPasskeyReady });
}

async function reinviteIdentity(identityId, request, env, admin) {
  const identity = await env.DB.prepare("SELECT id FROM security_identities WHERE id = ? AND status != 'disabled'").bind(identityId).first();
  if (!identity) throw new HttpError(404, "Identityが見つかりません。");
  const body = await readJson(request, 4096);
  const invitation = await issueInvitation(env, identityId, body.expiresAt, admin.identityId);
  await writeLocalAudit(env, { eventType: "reinvite", outcome: "success", identityId, authMethod: "passkey", details: { expiresAt: invitation.expiresAt } }, request);
  return json({ invitationUrl: `/security/#invite=${encodeURIComponent(invitation.token)}`, expiresAt: invitation.expiresAt }, 201);
}

async function revokeCredential(credentialId, env, admin) {
  const credential = await env.DB.prepare("SELECT identity_id FROM security_credentials WHERE credential_id = ? AND status != 'revoked'").bind(credentialId).first();
  if (!credential) throw new HttpError(404, "パスキーが見つかりません。");
  const result = await env.DB.prepare("UPDATE security_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE credential_id = ? AND status != 'revoked'").bind(credentialId).run();
  if (!result.meta?.changes) throw new HttpError(404, "パスキーが見つかりません。");
  await writeLocalAudit(env, { eventType: "passkey_revoked", outcome: "success", identityId: credential.identity_id, authMethod: "passkey", details: { revokedBy: admin.identityId } });
  return json({ ok: true });
}

async function revokeInvitation(invitationId, env, admin) {
  const row = await env.DB.prepare("SELECT identity_id FROM security_invitations WHERE id = ? AND status = 'active'").bind(invitationId).first();
  if (!row) throw new HttpError(404, "有効な招待が見つかりません。");
  await env.DB.prepare("UPDATE security_invitations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invitationId).run();
  await writeLocalAudit(env, { eventType: "invite_revoked", outcome: "success", identityId: row.identity_id, authMethod: "passkey", details: { revokedBy: admin.identityId } });
  return json({ ok: true });
}

async function listAuditEvents(url, env) {
  const clauses = ["1 = 1"];
  const values = [];
  for (const [parameter, column, normalize] of [
    ["service", "service", normalizeService], ["identityId", "identity_id", normalizeId],
    ["authMethod", "auth_method", (value) => ["password", "passkey", "system"].includes(value) ? value : ""],
    ["outcome", "outcome", (value) => ["success", "failure", "blocked", "cancelled", "info"].includes(value) ? value : ""],
    ["eventType", "event_type", (value) => normalizeText(value, 80)]
  ]) {
    const value = normalize(url.searchParams.get(parameter));
    if (value) { clauses.push(`${column} = ?`); values.push(value); }
  }
  const from = normalizeDate(url.searchParams.get("from"));
  const to = normalizeDate(url.searchParams.get("to"));
  if (from) { clauses.push("occurred_at >= ?"); values.push(`${from}T00:00:00.000Z`); }
  if (to) { clauses.push("occurred_at < datetime(?, '+1 day')"); values.push(`${to}T00:00:00.000Z`); }
  const result = await env.DB.prepare(`SELECT * FROM security_audit_events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC LIMIT 500`).bind(...values).all();
  return json({ events: result.results || [] });
}

async function redeemHandoff(env, token, service) {
  const normalizedService = normalizeService(service);
  const tokenHash = await sha256(normalizeSecretText(token, 512));
  if (!normalizedService || !tokenHash) return null;
  const now = nowSeconds();
  const row = await env.DB.prepare(`SELECT h.id, h.identity_id, h.credential_id,
      l.id AS serviceLinkId, l.service, l.service_account_id AS serviceAccountId,
      l.cloud_root_folder_id AS cloudRootFolderId, l.display_label AS displayLabel
    FROM security_handoffs h JOIN security_service_links l ON l.id = h.service_link_id
    JOIN security_identities i ON i.id = h.identity_id
    JOIN security_credentials c ON c.credential_id = h.credential_id
    WHERE h.token_hash = ? AND h.consumed_at IS NULL AND h.expires_at > ?
      AND l.service = ? AND l.status = 'active' AND i.status = 'active' AND c.status = 'active'`)
    .bind(tokenHash, now, normalizedService).first();
  if (!row) return null;
  const update = await env.DB.prepare("UPDATE security_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(now, row.id).run();
  if (!update.meta?.changes) return null;
  return { identityId: row.identity_id, credentialId: row.credential_id, serviceLinkId: row.serviceLinkId, service: row.service, serviceAccountId: row.serviceAccountId, cloudRootFolderId: row.cloudRootFolderId == null ? null : Number(row.cloudRootFolderId), displayLabel: row.displayLabel };
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

async function activeLinks(env, identityId, service) {
  const result = await env.DB.prepare("SELECT * FROM security_service_links WHERE identity_id = ? AND service = ? AND status = 'active' ORDER BY created_at").bind(identityId, service).all();
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

async function issueInvitation(env, identityId, requestedExpiry, createdBy) {
  const now = nowSeconds();
  const max = now + clampNumber(env.MAX_INVITE_DAYS, 1, 30, 30) * 86400;
  const expiresAt = Math.min(max, Math.max(now + 3600, Number(requestedExpiry) || now + INVITE_DEFAULT_SECONDS));
  const token = randomToken(32);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO security_invitations
    (id, identity_id, token_hash, link_set_hash, expires_at, created_by_identity_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, identityId, await sha256(token), await serviceLinkSetHash(env, identityId), expiresAt, createdBy).run();
  return { id, token, expiresAt };
}

async function serviceLinkSetHash(env, identityId) {
  const result = await env.DB.prepare("SELECT service, service_account_id, cloud_root_folder_id, status FROM security_service_links WHERE identity_id = ? ORDER BY service, service_account_id, cloud_root_folder_id").bind(identityId).all();
  return sha256(JSON.stringify(result.results || []));
}

async function validateServiceLinks(env, input) {
  const raw = Array.isArray(input) ? input : [];
  const links = [];
  for (const item of raw.slice(0, 12)) {
    const service = normalizeService(item.service);
    const accountId = normalizeText(item.accountId, 100);
    const rootFolderId = item.rootFolderId == null || item.rootFolderId === "" ? null : Number(item.rootFolderId);
    if (!service || !accountId) throw new HttpError(400, "サービス連携を確認してください。");
    const integration = service === "cloud" ? env.CLOUD_AUTH : service === "diary" ? env.DIARY_AUTH : env.BILLING_AUTH;
    const description = await integration.describeAccount({ accountId, rootFolderId });
    if (!description?.valid) throw new HttpError(400, `${service}の連携先を確認できません。`);
    if (service === "cloud" && accountId !== "folder-member") {
      throw new HttpError(400, "T-Cloudの管理者・副管理者パスキーは第一管理者の復旧登録とは分離し、一般Identityにはfolder-memberを指定してください。");
    }
    links.push({ service, accountId, rootFolderId: description.rootFolderId ?? rootFolderId, displayLabel: normalizeText(description.displayLabel, 160) || accountId });
  }
  return links;
}

async function insertServiceLink(env, identityId, link) {
  const existing = await env.DB.prepare(`SELECT id, status FROM security_service_links
    WHERE identity_id = ? AND service = ? AND service_account_id = ?
      AND ((cloud_root_folder_id IS NULL AND ? IS NULL) OR cloud_root_folder_id = ?)`)
    .bind(identityId, link.service, link.accountId, link.rootFolderId, link.rootFolderId).first();
  if (existing?.status === "disabled") {
    await env.DB.prepare("UPDATE security_service_links SET display_label = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(link.displayLabel, existing.id).run();
    return;
  }
  if (existing) throw new HttpError(409, "同じサービス連携が既に存在します。");
  await env.DB.prepare(`INSERT INTO security_service_links
    (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(crypto.randomUUID(), identityId, link.service, link.accountId, link.rootFolderId, link.displayLabel).run();
}

async function ensurePrimaryAdminRecords(env) {
  await env.DB.prepare(`INSERT INTO security_identities (id, display_name, status, is_security_admin)
    VALUES (?, '第一管理者', 'invited', 1) ON CONFLICT(id) DO NOTHING`).bind(PRIMARY_ADMIN_ID).run();
  const defaults = [
    { service: "cloud", accountId: "admin", rootFolderId: null, displayLabel: "T-Cloud 管理者" },
    { service: "diary", accountId: "main-admin", rootFolderId: null, displayLabel: "日記 管理者" },
    { service: "billing", accountId: "owner", rootFolderId: null, displayLabel: "請求書 owner" }
  ];
  for (const link of defaults) {
    const existing = await env.DB.prepare(`SELECT id FROM security_service_links
      WHERE identity_id = ? AND service = ? AND service_account_id = ?
        AND cloud_root_folder_id IS NULL LIMIT 1`).bind(PRIMARY_ADMIN_ID, link.service, link.accountId).first();
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
      AND occurred_at >= datetime('now', '-15 minutes')`).bind(hash).first();
  if (Number(recent?.attempts || 0) >= 5) {
    await writeLocalAudit(env, { eventType: "bootstrap_login_blocked", outcome: "blocked", authMethod: "password", serviceAccountId: "admin" }, request);
    throw new HttpError(429, "管理者確認が一時停止されています。15分ほど待ってからお試しください。");
  }
}

async function requireSecurityAdmin(request, env) {
  const session = await readSecuritySession(request, env, ADMIN_COOKIE, "admin");
  if (!session) throw new HttpError(401, "Security Centerの管理者認証が必要です。");
  const identity = await env.DB.prepare(`SELECT i.id FROM security_identities i
    JOIN security_credentials c ON c.identity_id = i.id
    WHERE i.id = ? AND i.is_security_admin = 1 AND i.status = 'active'
      AND c.credential_id = ? AND c.status = 'active'`).bind(session.identityId, session.credentialId).first();
  if (!identity) throw new HttpError(403, "Security Centerを管理する権限がありません。");
  return session;
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
  const headers = new Headers();
  const identityTtl = clampNumber(env.IDENTITY_SESSION_TTL_SECONDS, 60, 900, 600);
  headers.append("Set-Cookie", await signedCookie(env, IDENTITY_COOKIE, { kind: "identity", identityId, credentialId }, identityTtl, url.protocol === "https:"));
  if (admin) {
    const adminTtl = clampNumber(env.ADMIN_SESSION_TTL_SECONDS, 300, 7200, 3600);
    headers.append("Set-Cookie", await signedCookie(env, ADMIN_COOKIE, { kind: "admin", identityId, credentialId }, adminTtl, url.protocol === "https:"));
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
  const token = parseCookies(request.headers.get("Cookie") || "")[name];
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !(await safeEqual(signature, await hmac(payload, env.SESSION_SECRET)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return value.kind === expectedKind && value.exp > nowSeconds() ? value : null;
  } catch { return null; }
}

async function tcloudEnvelopeBundle(env, identityId, credentialId, linkId) {
  const result = await env.DB.prepare(`SELECT envelope_type, public_key_jwk, encrypted_payload, payload_iv, wrapped_key
    FROM security_tcloud_key_envelopes WHERE identity_id = ? AND credential_id = ? AND service_link_id = ?`)
    .bind(identityId, credentialId, linkId).all();
  return Object.fromEntries((result.results || []).map((row) => [row.envelope_type, {
    publicKeyJwk: row.public_key_jwk ? parseJson(row.public_key_jwk, null) : null,
    encryptedPayload: row.encrypted_payload || null, payloadIv: row.payload_iv || null, wrappedKey: row.wrapped_key || null
  }]));
}

async function storeAuditEvent(env, input) {
  const event = normalizeAuditEvent(input);
  if (!event.identityId && event.serviceAccountId && event.service !== "security") {
    const linked = await env.DB.prepare(`SELECT identity_id FROM security_service_links
      WHERE service = ? AND service_account_id = ? AND status = 'active'
      ORDER BY created_at LIMIT 2`).bind(event.service, event.serviceAccountId).all();
    if ((linked.results || []).length === 1) event.identityId = linked.results[0].identity_id;
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO security_audit_events
    (event_id, occurred_at, service, event_type, outcome, identity_id, service_account_id,
      role, auth_method, session_id_hash, source_hash, user_agent, target_type, target_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.eventId, event.occurredAt, event.service, event.eventType, event.outcome, event.identityId,
      event.serviceAccountId, event.role, event.authMethod, event.sessionIdHash, event.sourceHash,
      event.userAgent, event.targetType, event.targetId, JSON.stringify(event.details)).run();
}

async function writeLocalAudit(env, input, request = null) {
  await storeAuditEvent(env, {
    eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), service: input.service || "security",
    eventType: input.eventType, outcome: input.outcome || "info", identityId: input.identityId || null,
    serviceAccountId: input.serviceAccountId || null, role: input.role || null,
    authMethod: input.authMethod || "system", sourceHash: request ? await sourceHash(request, env) : null,
    userAgent: request?.headers.get("User-Agent") || null, details: input.details || {}
  });
}

function normalizeAuditEvent(input) {
  const service = ["security", "cloud", "diary", "billing"].includes(input?.service) ? input.service : "security";
  const outcome = ["success", "failure", "blocked", "cancelled", "info"].includes(input?.outcome) ? input.outcome : "info";
  const authMethod = ["password", "passkey", "system"].includes(input?.authMethod) ? input.authMethod : null;
  return {
    eventId: normalizeId(input?.eventId) || crypto.randomUUID(), occurredAt: validIso(input?.occurredAt) || new Date().toISOString(),
    service, eventType: normalizeText(input?.eventType, 80) || "unknown", outcome,
    identityId: normalizeId(input?.identityId) || null, serviceAccountId: normalizeText(input?.serviceAccountId, 100) || null,
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

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", headers.get("Cache-Control") || "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireMutation(request, url) {
  if (request.headers.get("Origin") !== url.origin || !String(request.headers.get("Content-Type") || "").startsWith("application/json")) {
    throw new HttpError(403, "不正なリクエストです。");
  }
}

function publicLink(row) {
  return { id: row.id, service: row.service, accountId: row.service_account_id, rootFolderId: row.cloud_root_folder_id == null ? null : Number(row.cloud_root_folder_id), displayLabel: row.display_label };
}

function passkeysEnabled(env) { return String(env.PASSKEY_ENABLED || "true") === "true"; }
function rpId(env) { return env.RP_ID || "tanaka-note.com"; }
function expectedOrigins(env) { return String(env.EXPECTED_ORIGIN || "https://tanaka-note.com").split(",").map((value) => value.trim()).filter(Boolean).concat(env.ALLOW_LOCAL_HTTP === "true" ? ["http://127.0.0.1:8790", "http://localhost:8790"] : []); }
function normalizeService(value) { return ["cloud", "diary", "billing"].includes(value) ? value : ""; }
function normalizeAuthService(value) { return ["security", "cloud", "diary", "billing"].includes(value) ? value : ""; }
function normalizeId(value) { const text = String(value || "").trim(); return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : ""; }
function normalizeText(value, max) { return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : ""; }
function normalizeSecretText(value, max) { const text = typeof value === "string" ? value.trim() : ""; return text.length <= max ? text : ""; }
function normalizeDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function validIso(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }
function randomToken(bytes) { const value = crypto.getRandomValues(new Uint8Array(bytes)); return bytesToBase64Url(value); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function validatePublicJwk(value) { if (!value || value.kty !== "RSA" || value.alg !== "RSA-OAEP-256" || !value.n || !value.e || "d" in value) throw new HttpError(400, "公開鍵を確認してください。"); return { kty: "RSA", alg: "RSA-OAEP-256", key_ops: ["encrypt"], ext: true, n: value.n, e: value.e }; }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; })); }
function clearCookie(name, secureValue) { return `${name}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secureValue ? "; Secure" : ""}`; }
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const length = Number(request.headers.get("Content-Length") || 0); if (length > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const body = await request.json(); return body && typeof body === "object" ? body : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
async function sha256(value) { return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))))); }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function safeEqual(left, right) { const a = base64UrlToBytes(left); const b = base64UrlToBytes(right); if (a.length !== b.length) return false; let result = 0; for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index]; return result === 0; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(value) { const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "="); return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); }
function safeErrorName(error) { return error instanceof Error ? `${error.name}:${String(error.message || "").slice(0, 160)}` : "unknown"; }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

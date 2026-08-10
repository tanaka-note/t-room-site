const BASE_PATH = "/cloud";
const SESSION_COOKIE = "troom_cloud_session";
const SHARE_SESSION_COOKIE = "troom_cloud_share_session";
const SESSION_ALGORITHM = "HMAC";
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const encoder = new TextEncoder();
const MIN_MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_MULTIPART_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10000;
const MAX_FILE_BYTES = MAX_MULTIPART_CHUNK_BYTES * MAX_MULTIPART_PARTS - MAX_MULTIPART_PARTS * 32;

const ACCOUNTS = [
  { role: "admin", label: "管理者", secretKey: "ADMIN_PASSWORD_HASH", proofSecretKey: "ADMIN_AUTH_PROOF_HASH", canUpload: true, canDelete: true, canTrashUnlockedFiles: true, canEditFiles: true, canEditFolders: true, canRenameUnlockedItems: true, canViewHistory: true, canRequestDelete: false, canReviewDeletion: false },
  { role: "subadmin", label: "副管理者", secretKey: "SUBADMIN_PASSWORD_HASH", proofSecretKey: "SUBADMIN_AUTH_PROOF_HASH", canUpload: true, canDelete: false, canTrashUnlockedFiles: true, canEditFiles: false, canEditFolders: false, canRenameUnlockedItems: true, canViewHistory: true, canRequestDelete: false, canReviewDeletion: false }
];

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === `${BASE_PATH}.html`) return Response.redirect(`${url.origin}${BASE_PATH}/`, 301);
      if (!url.pathname.startsWith(BASE_PATH)) return new Response("Not found", { status: 404 });
      const path = url.pathname.slice(BASE_PATH.length) || "/";
      if (path.startsWith("/api/")) return secureResponse(await handleApi(request, env, url, path));
      return secureResponse(await serveAsset(request, env, url, path));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return secureResponse(json({ error: status === 500 ? "処理中に問題が発生しました。" : error.message }, status));
    }
  },

  async scheduled(_controller, env) {
    await abortStaleUploads(env);
  }
};

async function handleApi(request, env, url, path) {
  if (path === "/api/session" && request.method === "GET") {
    const session = await readSession(request, env);
    if (!session) return json({ authenticated: false });
    if (session.role !== "subadmin") return json({ authenticated: true, ...publicSession(session, env) });
    const maxAge = sessionMaxAge(env, session.role);
    const token = await createSessionToken(session, maxAge, env);
    const headers = new Headers({ "Set-Cookie": sessionCookie(token, maxAge, url.protocol === "https:") });
    return json({ authenticated: true, ...publicSession(session, env) }, 200, headers);
  }

  if (path === "/api/auth-mode" && request.method === "GET") {
    return json({ mode: env.ADMIN_AUTH_PROOF_HASH && env.SUBADMIN_AUTH_PROOF_HASH ? "proof" : "legacy" });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!sameOrigin(request, url)) throw new HttpError(403, "不正なリクエストです。");
    return login(request, env, url);
  }

  if (path === "/api/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) throw new HttpError(403, "不正なリクエストです。");
    const headers = new Headers({ "Set-Cookie": clearCookie(url.protocol === "https:") });
    return json({ ok: true }, 200, headers);
  }

  const publicShareMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})$/);
  if (publicShareMatch && request.method === "GET") return getPublicShareInfo(publicShareMatch[1], env);
  const publicShareUnlockMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})\/unlock$/);
  if (publicShareUnlockMatch && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    return unlockPublicShare(publicShareUnlockMatch[1], request, env, url);
  }
  const publicShareItemsMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})\/items$/);
  if (publicShareItemsMatch && request.method === "GET") return listPublicShareItems(publicShareItemsMatch[1], request, env, url);
  const publicShareThumbMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})\/files\/(\d+)\/thumbnail$/);
  if (publicShareThumbMatch && request.method === "GET") return getPublicShareThumbnail(publicShareThumbMatch[1], Number(publicShareThumbMatch[2]), request, env);
  const publicShareContentMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})\/files\/(\d+)\/(view|download)$/);
  if (publicShareContentMatch && request.method === "GET") return getPublicShareContent(publicShareContentMatch[1], Number(publicShareContentMatch[2]), publicShareContentMatch[3], request, env);
  const publicShareEventsMatch = path.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})\/events$/);
  if (publicShareEventsMatch && request.method === "GET") return listPublicShareEvents(publicShareEventsMatch[1], request, env);
  if (publicShareEventsMatch && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    return recordPublicShareEvent(publicShareEventsMatch[1], request, env);
  }

  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, "ログインが必要です。");
  if (request.method !== "GET" && !validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");

  if (path === "/api/items" && request.method === "GET") return listItems(url, env, session);
  if (path === "/api/upload-conflict-candidates" && request.method === "POST") return listUploadConflictCandidates(request, env, session);
  if (path === "/api/conflicts" && request.method === "GET") return listStoredConflictCandidates(url, env, session);
  if (path === "/api/legacy-folders" && request.method === "GET") return listLegacyFolders(env, session);
  if (path === "/api/folders" && request.method === "POST") return createFolder(request, env, session);
  if (path === "/api/uploads" && request.method === "POST") return createUpload(request, env, session);
  if (path === "/api/trash" && request.method === "GET") return listTrash(env, session);
  if (path === "/api/trash" && request.method === "DELETE") return emptyTrash(env, session);
  if (path === "/api/usage" && request.method === "GET") return getUsage(env, session);
  if (path === "/api/usage-details" && request.method === "GET") return getUsageDetails(env, session);
  if (path === "/api/upload-history" && request.method === "GET") return listUploadHistory(env, session);
  if (path === "/api/download-events" && request.method === "POST") return recordDownloadEvent(request, env, session);
  if (path === "/api/deletion-requests" && request.method === "GET") return listDeletionRequests(env, session);
  if (path === "/api/crypto-config" && request.method === "GET") return getCryptoConfig(env, session);
  if (path === "/api/crypto-setup" && request.method === "POST") return setupCrypto(request, env, session);
  if (path === "/api/shares" && request.method === "GET") return listShares(env, session);
  if (path === "/api/shares" && request.method === "POST") return createShare(request, env, session);

  const shareStopMatch = path.match(/^\/api\/shares\/(\d+)\/stop$/);
  if (shareStopMatch && request.method === "POST") return stopShare(Number(shareStopMatch[1]), env, session);
  const shareEventsMatch = path.match(/^\/api\/shares\/(\d+)\/events$/);
  if (shareEventsMatch && request.method === "GET") return listAdminShareEvents(Number(shareEventsMatch[1]), env, session);

  const folderMatch = path.match(/^\/api\/folders\/(\d+)$/);
  if (folderMatch && request.method === "PATCH") return updateFolder(Number(folderMatch[1]), request, env, session);
  if (folderMatch && request.method === "DELETE") return deleteFolder(Number(folderMatch[1]), env, session);
  const folderRestoreMatch = path.match(/^\/api\/folders\/(\d+)\/restore$/);
  if (folderRestoreMatch && request.method === "POST") return restoreFolder(Number(folderRestoreMatch[1]), env, session);
  const folderUnlockMatch = path.match(/^\/api\/folders\/(\d+)\/unlock$/);
  if (folderUnlockMatch && request.method === "POST") return unlockFolder(Number(folderUnlockMatch[1]), request, env, session);

  const partMatch = path.match(/^\/api\/uploads\/(\d+)\/parts\/(\d+)$/);
  if (partMatch && request.method === "PUT") return uploadPart(Number(partMatch[1]), Number(partMatch[2]), request, env, session);
  const completeMatch = path.match(/^\/api\/uploads\/(\d+)\/complete$/);
  if (completeMatch && request.method === "POST") return completeUpload(Number(completeMatch[1]), request, env, session);
  const cancelMatch = path.match(/^\/api\/uploads\/(\d+)$/);
  if (cancelMatch && request.method === "DELETE") return cancelUpload(Number(cancelMatch[1]), env, session);

  const fileMatch = path.match(/^\/api\/files\/(\d+)$/);
  if (fileMatch && request.method === "GET") return getFile(Number(fileMatch[1]), env, session, request);
  if (fileMatch && request.method === "PATCH") return updateFile(Number(fileMatch[1]), request, env, session);
  if (fileMatch && request.method === "DELETE") return moveFileToTrash(Number(fileMatch[1]), env, session);
  const thumbMatch = path.match(/^\/api\/files\/(\d+)\/thumbnail$/);
  if (thumbMatch && request.method === "PUT") return putThumbnail(Number(thumbMatch[1]), request, env, session);
  if (thumbMatch && request.method === "GET") return getThumbnail(Number(thumbMatch[1]), env, session);
  const contentMatch = path.match(/^\/api\/files\/(\d+)\/(view|download)$/);
  if (contentMatch && request.method === "GET") return streamFile(Number(contentMatch[1]), contentMatch[2], request, env, session);
  const restoreMatch = path.match(/^\/api\/files\/(\d+)\/restore$/);
  if (restoreMatch && request.method === "POST") return restoreFile(Number(restoreMatch[1]), env, session);
  const permanentMatch = path.match(/^\/api\/files\/(\d+)\/permanent$/);
  if (permanentMatch && request.method === "DELETE") return permanentlyDeleteFile(Number(permanentMatch[1]), env, session);
  const deletionRequestMatch = path.match(/^\/api\/files\/(\d+)\/deletion-request$/);
  if (deletionRequestMatch && request.method === "POST") return requestFileDeletion(Number(deletionRequestMatch[1]), env, session);
  const deletionApprovalMatch = path.match(/^\/api\/deletion-requests\/(\d+)\/approve$/);
  if (deletionApprovalMatch && request.method === "POST") return approveDeletionRequest(Number(deletionApprovalMatch[1]), env, session);

  throw new HttpError(404, "Not found");
}

async function login(request, env, url) {
  const proofMode = Boolean(env.ADMIN_AUTH_PROOF_HASH && env.SUBADMIN_AUTH_PROOF_HASH);
  const configuredLoginId = String(env.LOGIN_ID || "").trim().toLowerCase();
  if ((!proofMode && (!env.ADMIN_PASSWORD_HASH || !env.SUBADMIN_PASSWORD_HASH)) || !env.SESSION_SECRET || !configuredLoginId) {
    throw new HttpError(503, "Cloud Storageの認証設定が完了していません。");
  }
  const body = await readJson(request, 4096);
  const loginId = String(body.loginId || "").trim().toLowerCase();
  const password = String(body.password || "");
  const authProof = String(body.authProof || "");
  if (loginId !== configuredLoginId || (proofMode ? !authProof || authProof.length > 256 : !password || password.length > 256)) {
    throw new HttpError(401, "IDまたはパスワードが違います。");
  }

  const fingerprint = await requestFingerprint(request, env);
  const attempt = await env.DB.prepare("SELECT failed_count, first_failed_at, locked_until FROM cloud_login_attempts WHERE fingerprint = ?").bind(fingerprint).first();
  const now = Math.floor(Date.now() / 1000);
  if (Number(attempt?.locked_until || 0) > now) throw new HttpError(429, "ログインが一時停止されています。しばらくしてからお試しください。");

  let account = null;
  for (const candidate of ACCOUNTS) {
    const credential = proofMode ? authProof : password;
    const hash = env[proofMode ? candidate.proofSecretKey : candidate.secretKey];
    if (await verifyPassword(credential, hash)) {
      account = candidate;
      break;
    }
  }
  if (!account) {
    await recordFailedLogin(env, fingerprint, attempt, now);
    throw new HttpError(401, "IDまたはパスワードが違います。");
  }
  await env.DB.prepare("DELETE FROM cloud_login_attempts WHERE fingerprint = ?").bind(fingerprint).run();
  const maxAge = sessionMaxAge(env, account.role);
  const session = {
    role: account.role,
    label: account.label,
    canUpload: account.canUpload,
    canDelete: account.canDelete,
    canEditFiles: account.canEditFiles,
    canEditFolders: account.canEditFolders,
    canViewHistory: account.canViewHistory,
    canRequestDelete: account.canRequestDelete,
    canReviewDeletion: account.canReviewDeletion,
    sessionId: crypto.randomUUID()
  };
  const token = await createSessionToken(session, maxAge, env);
  const headers = new Headers({ "Set-Cookie": sessionCookie(token, maxAge, url.protocol === "https:") });
  await audit(env, "login", session, null, null);
  return json({ authenticated: true, ...publicSession(session, env) }, 200, headers);
}

async function getCryptoConfig(env, session) {
  const row = await env.DB.prepare(`SELECT crypto_version AS cryptoVersion, public_key_jwk AS publicKeyJwk,
    admin_private_cipher AS adminPrivateCipher, admin_private_iv AS adminPrivateIv,
    recovery_private_cipher AS recoveryPrivateCipher, recovery_private_iv AS recoveryPrivateIv,
    created_at AS createdAt FROM cloud_crypto_config WHERE id = 1`).first();
  if (!row) return json({ initialized: false, cryptoVersion: 1 });
  const result = {
    initialized: true,
    cryptoVersion: Number(row.cryptoVersion || 1),
    publicKeyJwk: JSON.parse(row.publicKeyJwk),
    createdAt: row.createdAt
  };
  if (session.role === "admin") {
    result.adminPrivateCipher = row.adminPrivateCipher;
    result.adminPrivateIv = row.adminPrivateIv;
    result.recoveryPrivateCipher = row.recoveryPrivateCipher;
    result.recoveryPrivateIv = row.recoveryPrivateIv;
  }
  return json(result);
}

async function setupCrypto(request, env, session) {
  if (session.role !== "admin") throw new HttpError(403, "暗号化の初期設定は管理者のみ行えます。");
  const existing = await env.DB.prepare("SELECT 1 AS ok FROM cloud_crypto_config WHERE id = 1").first();
  if (existing) throw new HttpError(409, "暗号化の初期設定は完了しています。");
  const body = await readJson(request, 100000);
  const publicKeyJwk = validateRsaPublicJwk(body.publicKeyJwk);
  const adminPrivateCipher = validCryptoText(body.adminPrivateCipher, 16000, "管理者鍵");
  const adminPrivateIv = validCryptoText(body.adminPrivateIv, 64, "管理者鍵IV");
  const recoveryPrivateCipher = validCryptoText(body.recoveryPrivateCipher, 16000, "復旧鍵");
  const recoveryPrivateIv = validCryptoText(body.recoveryPrivateIv, 64, "復旧鍵IV");
  try {
    await env.DB.prepare(`INSERT INTO cloud_crypto_config
      (id, crypto_version, public_key_jwk, admin_private_cipher, admin_private_iv, recovery_private_cipher, recovery_private_iv)
      VALUES (1, 1, ?, ?, ?, ?, ?)`)
      .bind(JSON.stringify(publicKeyJwk), adminPrivateCipher, adminPrivateIv, recoveryPrivateCipher, recoveryPrivateIv).run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "暗号化の初期設定は完了しています。");
    throw error;
  }
  await env.DB.prepare("INSERT INTO cloud_security_events (event_type, actor_role, details_json) VALUES ('crypto_initialized', ?, ?)")
    .bind(session.role, JSON.stringify({ version: 1 })).run();
  await audit(env, "crypto_initialized", session, "crypto", 1, { version: 1 });
  return json({ ok: true, initialized: true, cryptoVersion: 1 }, 201);
}

async function createShare(request, env, session) {
  requireAdmin(session);
  const body = await readJson(request, 65536);
  const token = normalizeShareToken(body.token);
  const targetType = ["folder", "file", "selection"].includes(body.targetType) ? body.targetType : "";
  const targetId = optionalId(body.targetId);
  if (!targetType || !targetId) throw new HttpError(400, "共有対象を確認してください。");
  const expiresAt = Number(body.expiresAt);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiresAt) || expiresAt < now + 5 * 60 || expiresAt > now + 10 * 365 * 24 * 60 * 60) {
    throw new HttpError(400, "共有期限は5分後から10年以内で設定してください。");
  }
  const storedTargetType = targetType === "selection" ? "file" : targetType;
  const target = storedTargetType === "folder"
    ? await env.DB.prepare("SELECT id, crypto_version AS cryptoVersion FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(targetId).first()
    : await env.DB.prepare("SELECT id, crypto_version AS cryptoVersion FROM cloud_files WHERE id = ? AND deleted_at IS NULL AND status = 'ready'").bind(targetId).first();
  if (!target) throw new HttpError(404, "共有対象が見つかりません。");
  if (Number(target.cryptoVersion) !== 1) throw new HttpError(400, "暗号化済みの対象だけ共有できます。");
  let selectedFiles = [];
  if (targetType === "selection") {
    if (!Array.isArray(body.selectedFiles) || body.selectedFiles.length < 2 || body.selectedFiles.length > 100) {
      throw new HttpError(400, "共有するファイルは2件以上100件以内で選択してください。");
    }
    const ids = new Set();
    for (let index = 0; index < body.selectedFiles.length; index++) {
      const record = body.selectedFiles[index];
      const id = optionalId(record?.id);
      if (!id || ids.has(id)) throw new HttpError(400, "共有するファイルを確認してください。");
      ids.add(id);
      selectedFiles.push({
        id,
        position: index,
        shareWrappedFileKey: index === 0 ? null : validCryptoText(record.shareWrappedFileKey, 512, "共有ファイル鍵"),
        shareFileKeyIv: index === 0 ? null : validCryptoText(record.shareFileKeyIv, 64, "共有ファイル鍵IV")
      });
    }
    const placeholders = selectedFiles.map(() => "?").join(",");
    const available = await env.DB.prepare(`SELECT id FROM cloud_files WHERE id IN (${placeholders})
      AND crypto_version = 1 AND deleted_at IS NULL AND status = 'ready'`).bind(...selectedFiles.map((file) => file.id)).all();
    if ((available.results || []).length !== selectedFiles.length) throw new HttpError(404, "共有するファイルが見つかりません。");
    if (selectedFiles[0].id !== targetId) throw new HttpError(400, "共有の基準ファイルを確認してください。");
  }
  const authProof = validCryptoText(body.authProof, 256, "共有認証");
  const tokenHash = await sha256Base64Url(token);
  const encryptedToken = validCryptoText(body.encryptedToken, 256, "共有URL");
  const tokenIv = validCryptoText(body.tokenIv, 64, "共有URL IV");
  const passwordSalt = validCryptoText(body.passwordSalt, 128, "共有Salt");
  const passwordWrappedKey = validCryptoText(body.passwordWrappedKey, 512, "共有鍵");
  const passwordWrapIv = validCryptoText(body.passwordWrapIv, 64, "共有鍵IV");
  const passwordHash = await hashPassword(authProof);
  try {
    const result = await env.DB.prepare(`INSERT INTO cloud_shares
      (token_hash, encrypted_token, token_iv, target_type, target_id, password_hash,
        password_salt, password_wrapped_key, password_wrap_iv, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin')`)
      .bind(tokenHash, encryptedToken, tokenIv, storedTargetType, targetId, passwordHash,
        passwordSalt, passwordWrappedKey, passwordWrapIv, expiresAt).run();
    const id = Number(result.meta.last_row_id);
    if (selectedFiles.length) {
      try {
        await env.DB.batch(selectedFiles.map((file) => env.DB.prepare(`INSERT INTO cloud_share_files
          (share_id, file_id, share_wrapped_file_key, share_file_key_iv, position) VALUES (?, ?, ?, ?, ?)`)
          .bind(id, file.id, file.shareWrappedFileKey, file.shareFileKeyIv, file.position)));
      } catch (error) {
        await env.DB.prepare("DELETE FROM cloud_shares WHERE id = ?").bind(id).run();
        throw error;
      }
    }
    await audit(env, "share_created", session, targetType, targetId, { shareId: id, expiresAt, fileCount: selectedFiles.length || undefined });
    return json({ id, targetType, targetId, expiresAt, sharePath: `${BASE_PATH}/share/${token}` }, 201);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "共有URLが重複しました。もう一度生成してください。");
    throw error;
  }
}

async function listShares(env, session) {
  requireAdmin(session);
  const result = await env.DB.prepare(`
    SELECT s.id, s.encrypted_token AS encryptedToken, s.token_iv AS tokenIv,
      s.target_type AS targetType, s.target_id AS targetId, s.expires_at AS expiresAt,
      s.created_at AS createdAt, s.stopped_at AS stoppedAt,
      f.id AS fileId, f.folder_id AS fileFolderId, f.size_bytes AS fileSizeBytes,
      f.crypto_version AS fileCryptoVersion, f.encrypted_metadata AS fileEncryptedMetadata,
      f.metadata_iv AS fileMetadataIv, f.wrapped_file_key AS fileWrappedFileKey,
      f.file_key_iv AS fileFileKeyIv, f.deleted_at AS fileDeletedAt, f.status AS fileStatus,
      ff.crypto_version AS fileFolderCryptoVersion, ff.encrypted_name AS fileFolderEncryptedName,
      ff.name_iv AS fileFolderNameIv, ff.password_salt AS fileFolderPasswordSalt,
      ff.password_wrapped_key AS fileFolderPasswordWrappedKey, ff.password_wrap_iv AS fileFolderPasswordWrapIv,
      ff.admin_wrapped_key AS fileFolderAdminWrappedKey,
      fo.id AS folderId, fo.parent_id AS folderParentId, fo.name AS folderName, fo.crypto_version AS folderCryptoVersion,
      fo.encrypted_name AS folderEncryptedName, fo.name_iv AS folderNameIv,
      fo.password_salt AS folderPasswordSalt, fo.password_wrapped_key AS folderPasswordWrappedKey,
      fo.password_wrap_iv AS folderPasswordWrapIv, fo.admin_wrapped_key AS folderAdminWrappedKey,
      fo.parent_wrapped_key AS folderParentWrappedKey, fo.parent_wrap_iv AS folderParentWrapIv,
      fo.deleted_at AS folderDeletedAt,
      (SELECT COUNT(*) FROM cloud_share_events e WHERE e.share_id = s.id AND e.event_type = 'download_completed') AS downloadCount,
      (SELECT COUNT(*) FROM cloud_share_events e WHERE e.share_id = s.id AND e.event_type = 'download_failed') AS errorCount,
      (SELECT COUNT(*) FROM cloud_share_files sf WHERE sf.share_id = s.id) AS fileSetCount,
      (SELECT COUNT(*) FROM cloud_share_files sf JOIN cloud_files mf ON mf.id = sf.file_id
        WHERE sf.share_id = s.id AND mf.deleted_at IS NULL AND mf.status = 'ready') AS readyFileSetCount
    FROM cloud_shares s
    LEFT JOIN cloud_files f ON s.target_type = 'file' AND f.id = s.target_id
    LEFT JOIN cloud_folders ff ON ff.id = f.folder_id
    LEFT JOIN cloud_folders fo ON s.target_type = 'folder' AND fo.id = s.target_id
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT 1000
  `).all();
  const now = Math.floor(Date.now() / 1000);
  const shares = (result.results || []).map((row) => {
    const isSelection = Number(row.fileSetCount || 0) > 0;
    const unavailable = isSelection ? Number(row.readyFileSetCount || 0) === 0 : row.targetType === "file"
      ? !row.fileId || Boolean(row.fileDeletedAt) || row.fileStatus !== "ready"
      : !row.folderId || Boolean(row.folderDeletedAt);
    const status = row.stoppedAt ? "stopped" : Number(row.expiresAt) <= now ? "expired" : unavailable ? "unavailable" : "active";
    return {
      id: row.id,
      encryptedToken: row.encryptedToken,
      tokenIv: row.tokenIv,
      targetType: isSelection ? "selection" : row.targetType,
      targetId: row.targetId,
      fileCount: Number(row.fileSetCount || 0),
      expiresAt: Number(row.expiresAt),
      createdAt: row.createdAt,
      stoppedAt: row.stoppedAt,
      status,
      downloadCount: Number(row.downloadCount || 0),
      errorCount: Number(row.errorCount || 0),
      file: row.fileId ? {
        id: row.fileId, folderId: row.fileFolderId, sizeBytes: Number(row.fileSizeBytes || 0),
        cryptoVersion: row.fileCryptoVersion, encryptedMetadata: row.fileEncryptedMetadata,
        metadataIv: row.fileMetadataIv, wrappedFileKey: row.fileWrappedFileKey, fileKeyIv: row.fileFileKeyIv,
        folderCryptoVersion: row.fileFolderCryptoVersion, folderEncryptedName: row.fileFolderEncryptedName,
        folderNameIv: row.fileFolderNameIv, folderPasswordSalt: row.fileFolderPasswordSalt,
        folderPasswordWrappedKey: row.fileFolderPasswordWrappedKey, folderPasswordWrapIv: row.fileFolderPasswordWrapIv,
        folderAdminWrappedKey: row.fileFolderAdminWrappedKey
      } : null,
      folder: row.folderId ? {
        id: row.folderId, parentId: row.folderParentId, name: row.folderName, cryptoVersion: row.folderCryptoVersion,
        encryptedName: row.folderEncryptedName, nameIv: row.folderNameIv,
        passwordSalt: row.folderPasswordSalt, passwordWrappedKey: row.folderPasswordWrappedKey,
        passwordWrapIv: row.folderPasswordWrapIv, adminWrappedKey: row.folderAdminWrappedKey,
        parentWrappedKey: row.folderParentWrappedKey, parentWrapIv: row.folderParentWrapIv
      } : null
    };
  });
  return json({ shares });
}

async function stopShare(id, env, session) {
  requireAdmin(session);
  const share = await env.DB.prepare("SELECT id, stopped_at AS stoppedAt FROM cloud_shares WHERE id = ?").bind(id).first();
  if (!share) throw new HttpError(404, "共有URLが見つかりません。");
  if (!share.stoppedAt) await env.DB.prepare("UPDATE cloud_shares SET stopped_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), id).run();
  await audit(env, "share_stopped", session, "share", id);
  return json({ ok: true, status: "stopped" });
}

async function getPublicShareInfo(token, env) {
  const share = await requireShareByToken(token, env, true);
  const fileSetCount = await shareSelectionCount(env, share.id);
  return json({
    targetType: fileSetCount ? "selection" : share.target_type,
    expiresAt: Number(share.expires_at),
    cryptoVersion: 1,
    passwordSalt: share.password_salt,
    passwordWrappedKey: share.password_wrapped_key,
    passwordWrapIv: share.password_wrap_iv
  });
}

async function unlockPublicShare(token, request, env, url) {
  const share = await requireShareByToken(token, env, true);
  const body = await readJson(request, 4096);
  const authProof = validCryptoText(body.authProof, 256, "共有認証");
  const fingerprint = await requestFingerprint(request, env);
  const attempt = await env.DB.prepare("SELECT failed_count, first_failed_at, locked_until FROM cloud_share_attempts WHERE share_id = ? AND fingerprint = ?")
    .bind(share.id, fingerprint).first();
  const now = Math.floor(Date.now() / 1000);
  if (Number(attempt?.locked_until || 0) > now) throw new HttpError(429, "共有パスワードの入力が一時停止されています。");
  if (!(await verifyPassword(authProof, share.password_hash))) {
    await recordFailedShareUnlock(env, share.id, fingerprint, attempt, now);
    await env.DB.prepare("INSERT INTO cloud_share_events (share_id, event_type, error_code) VALUES (?, 'unlock_failed', 'invalid_password')").bind(share.id).run();
    throw new HttpError(401, "共有パスワードが違います。");
  }
  await env.DB.prepare("DELETE FROM cloud_share_attempts WHERE share_id = ? AND fingerprint = ?").bind(share.id, fingerprint).run();
  const maxAge = Math.max(60, Math.min(24 * 60 * 60, Number(share.expires_at) - now));
  const sessionId = crypto.randomUUID();
  const sessionToken = await createShareSessionToken(share, sessionId, maxAge, env);
  const headers = new Headers({ "Set-Cookie": shareSessionCookie(sessionToken, maxAge, url.protocol === "https:") });
  await env.DB.prepare("INSERT INTO cloud_share_events (share_id, event_type, session_id) VALUES (?, 'unlock_success', ?)").bind(share.id, sessionId).run();
  return json({ authenticated: true, targetType: (await shareSelectionCount(env, share.id)) ? "selection" : share.target_type, expiresAt: Number(share.expires_at) }, 200, headers);
}

async function listPublicShareItems(token, request, env, url) {
  const share = await requireAuthorizedShare(token, request, env);
  const fileSetCount = await shareSelectionCount(env, share.id);
  if (fileSetCount) {
    const selected = await env.DB.prepare(`SELECT f.*, sf.share_wrapped_file_key AS shareWrappedFileKey,
      sf.share_file_key_iv AS shareFileKeyIv, sf.position
      FROM cloud_share_files sf JOIN cloud_files f ON f.id = sf.file_id
      WHERE sf.share_id = ? AND f.deleted_at IS NULL AND f.status = 'ready'
      ORDER BY sf.position ASC`).bind(share.id).all();
    return json({
      targetType: "selection",
      rootFileId: Number(share.target_id),
      files: (selected.results || []).map((file) => ({ ...mapFile(file), shareWrappedFileKey: file.shareWrappedFileKey, shareFileKeyIv: file.shareFileKeyIv })),
      expiresAt: Number(share.expires_at)
    });
  }
  if (share.target_type === "file") {
    const file = await requireReadyFile(env, Number(share.target_id), false);
    return json({ targetType: "file", file: mapFile(file), expiresAt: Number(share.expires_at) });
  }
  const requestedFolderId = optionalId(url.searchParams.get("folderId")) || Number(share.target_id);
  if (!(await folderWithinShare(env, requestedFolderId, Number(share.target_id)))) throw new HttpError(403, "共有範囲外のフォルダです。");
  const folder = await requireFolder(env, requestedFolderId);
  const folders = await env.DB.prepare(`SELECT id, parent_id AS parentId, name, crypto_version AS cryptoVersion,
    encrypted_name AS encryptedName, name_iv AS nameIv, parent_wrapped_key AS parentWrappedKey,
    parent_wrap_iv AS parentWrapIv, created_at AS createdAt, updated_at AS updatedAt
    FROM cloud_folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`).bind(requestedFolderId).all();
  const files = await env.DB.prepare(`SELECT * FROM cloud_files WHERE folder_id = ? AND deleted_at IS NULL
    AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 500`).bind(requestedFolderId).all();
  return json({
    targetType: "folder",
    rootFolderId: Number(share.target_id),
    folder: publicFolderRecord(folder),
    folders: (folders.results || []).map(publicFolderRecord),
    files: (files.results || []).map(mapFile),
    expiresAt: Number(share.expires_at)
  });
}

async function getPublicShareThumbnail(token, fileId, request, env) {
  const share = await requireAuthorizedShare(token, request, env);
  const file = await requireSharedFile(env, share, fileId);
  if (!file.thumbnail_key) throw new HttpError(404, "サムネイルがありません。");
  const object = await env.FILES.get(file.thumbnail_key);
  if (!object) throw new HttpError(404, "サムネイルがありません。");
  return objectResponse(object, "inline", "encrypted-thumbnail.bin", "application/octet-stream");
}

async function getPublicShareContent(token, fileId, disposition, request, env) {
  const share = await requireAuthorizedShare(token, request, env);
  const file = await requireSharedFile(env, share, fileId);
  const rangeHeader = request.headers.get("Range");
  const object = await env.FILES.get(file.object_key, rangeHeader ? { range: request.headers } : undefined);
  if (!object) throw new HttpError(404, "ファイル本体が見つかりません。");
  if (disposition === "download" && (!rangeHeader || /^bytes=0-/i.test(rangeHeader))) {
    const shareSession = await readShareSession(request, env, share);
    await env.DB.prepare("INSERT INTO cloud_share_events (share_id, event_type, file_id, session_id) VALUES (?, 'download_started', ?, ?)")
      .bind(share.id, fileId, shareSession.sessionId).run();
  }
  return objectResponse(object, disposition === "download" ? "attachment" : "inline", "encrypted-file.bin", "application/octet-stream", Boolean(rangeHeader));
}

async function recordPublicShareEvent(token, request, env) {
  const share = await requireAuthorizedShare(token, request, env);
  const shareSession = await readShareSession(request, env, share);
  const body = await readJson(request, 4096);
  const eventType = ["download_completed", "download_failed"].includes(body.eventType) ? body.eventType : "";
  const fileId = optionalId(body.fileId);
  if (!eventType || !fileId) throw new HttpError(400, "履歴情報を確認してください。");
  await requireSharedFile(env, share, fileId);
  const errorCode = eventType === "download_failed" ? normalizeText(body.errorCode || "client_error", 80) : null;
  await env.DB.prepare("INSERT INTO cloud_share_events (share_id, event_type, file_id, session_id, error_code) VALUES (?, ?, ?, ?, ?)")
    .bind(share.id, eventType, fileId, shareSession.sessionId, errorCode).run();
  return json({ ok: true }, 201);
}

async function listPublicShareEvents(token, request, env) {
  const share = await requireAuthorizedShare(token, request, env);
  return json({ events: await shareEvents(env, share.id) });
}

async function listAdminShareEvents(id, env, session) {
  requireAdmin(session);
  const share = await env.DB.prepare("SELECT id FROM cloud_shares WHERE id = ?").bind(id).first();
  if (!share) throw new HttpError(404, "共有URLが見つかりません。");
  return json({ events: await shareEvents(env, id) });
}

async function shareEvents(env, shareId) {
  const result = await env.DB.prepare(`SELECT e.id, e.event_type AS eventType, e.file_id AS fileId,
    e.error_code AS errorCode, e.occurred_at AS occurredAt,
    f.folder_id AS folderId, f.size_bytes AS sizeBytes, f.crypto_version AS cryptoVersion,
    f.encrypted_metadata AS encryptedMetadata, f.metadata_iv AS metadataIv,
    f.wrapped_file_key AS wrappedFileKey, f.file_key_iv AS fileKeyIv,
    fo.crypto_version AS folderCryptoVersion, fo.encrypted_name AS folderEncryptedName,
    fo.name_iv AS folderNameIv, fo.password_salt AS folderPasswordSalt,
    fo.password_wrapped_key AS folderPasswordWrappedKey, fo.password_wrap_iv AS folderPasswordWrapIv,
    fo.admin_wrapped_key AS folderAdminWrappedKey
    FROM cloud_share_events e LEFT JOIN cloud_files f ON f.id = e.file_id
    LEFT JOIN cloud_folders fo ON fo.id = f.folder_id
    WHERE e.share_id = ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT 500`).bind(shareId).all();
  return (result.results || []).map((row) => ({
    id: row.id, eventType: row.eventType, fileId: row.fileId, errorCode: row.errorCode,
    occurredAt: row.occurredAt, folderId: row.folderId, sizeBytes: Number(row.sizeBytes || 0),
    cryptoVersion: row.cryptoVersion, encryptedMetadata: row.encryptedMetadata,
    metadataIv: row.metadataIv, wrappedFileKey: row.wrappedFileKey, fileKeyIv: row.fileKeyIv,
    folderCryptoVersion: row.folderCryptoVersion, folderEncryptedName: row.folderEncryptedName,
    folderNameIv: row.folderNameIv, folderPasswordSalt: row.folderPasswordSalt,
    folderPasswordWrappedKey: row.folderPasswordWrappedKey, folderPasswordWrapIv: row.folderPasswordWrapIv,
    folderAdminWrappedKey: row.folderAdminWrappedKey
  }));
}

async function listItems(url, env, session) {
  const folderId = optionalId(url.searchParams.get("folderId"));
  const uploadIndex = url.searchParams.get("uploadIndex") === "1";
  const foldersOnly = url.searchParams.get("foldersOnly") === "1";
  const uploadOffset = uploadIndex
    ? Math.min(100000, Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0))
    : 0;
  const query = normalizeText(url.searchParams.get("q"), 100).toLowerCase();
  const kind = ["image", "video", "audio", "document", "other"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "";
  const requestedSort = url.searchParams.get("sort") || "name-desc";
  const sort = ["updated-desc", "updated-asc", "name-asc", "name-desc", "size-desc", "size-asc", "newest", "oldest", "name", "size"].includes(requestedSort) ? requestedSort : "name-desc";
  const folder = folderId ? await env.DB.prepare(`SELECT f.id, f.parent_id, f.name,
    f.crypto_version AS cryptoVersion, f.encrypted_name AS encryptedName, f.name_iv AS nameIv,
    f.password_salt AS passwordSalt, f.password_wrapped_key AS passwordWrappedKey,
    f.password_wrap_iv AS passwordWrapIv, f.admin_wrapped_key AS adminWrappedKey,
    f.parent_wrapped_key AS parentWrappedKey, f.parent_wrap_iv AS parentWrapIv,
    f.password_hash IS NOT NULL AS is_protected,
    (SELECT COUNT(*) FROM cloud_files cf WHERE cf.folder_id = f.id AND cf.deleted_at IS NULL AND cf.status = 'ready') AS fileCount,
    (SELECT COUNT(*) FROM cloud_folders sf WHERE sf.parent_id = f.id AND sf.deleted_at IS NULL) AS folderCount
    FROM cloud_folders f WHERE f.id = ? AND f.deleted_at IS NULL`).bind(folderId).first() : null;
  if (folderId && !folder) throw new HttpError(404, "フォルダが見つかりません。");
  const folderAccessGranted = folderId ? await requireFolderAccess(env, folderId, session) : false;
  if (folderId && session.role === "subadmin" && !foldersOnly && !uploadIndex) {
    const total = await env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
      SELECT id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL
      UNION ALL
      SELECT child.id FROM cloud_folders child
      JOIN folder_tree parent ON child.parent_id = parent.id
      WHERE child.deleted_at IS NULL
    )
    SELECT COUNT(cf.id) AS totalFileCount, COALESCE(SUM(cf.size_bytes), 0) AS totalSizeBytes
    FROM folder_tree ft
    LEFT JOIN cloud_files cf ON cf.folder_id = ft.id AND cf.deleted_at IS NULL AND cf.status = 'ready'`)
      .bind(folderId).first();
    folder.totalFileCount = Number(total?.totalFileCount || 0);
    folder.totalSizeBytes = Number(total?.totalSizeBytes || 0);
  }

  const folderClauses = [folderId ? "f.parent_id = ?" : "f.parent_id IS NULL", "f.deleted_at IS NULL"];
  const folderValues = [session.sessionId, Math.floor(Date.now() / 1000), ...(folderId ? [folderId] : [])];
  if (query) { folderClauses.push("LOWER(f.name) LIKE ?"); folderValues.push(`%${query}%`); }
  const folders = await env.DB.prepare(`
    SELECT f.id, f.parent_id AS parentId, f.name, f.created_at AS createdAt, f.updated_at AS updatedAt,
      f.crypto_version AS cryptoVersion, f.encrypted_name AS encryptedName, f.name_iv AS nameIv,
      f.password_salt AS passwordSalt, f.password_wrapped_key AS passwordWrappedKey,
      f.password_wrap_iv AS passwordWrapIv, f.admin_wrapped_key AS adminWrappedKey,
      f.parent_wrapped_key AS parentWrappedKey, f.parent_wrap_iv AS parentWrapIv,
      f.password_hash IS NOT NULL AS isProtected,
      (SELECT COUNT(*) FROM cloud_files cf WHERE cf.folder_id = f.id AND cf.deleted_at IS NULL AND cf.status = 'ready') AS fileCount,
      (SELECT COUNT(*) FROM cloud_folders sf WHERE sf.parent_id = f.id AND sf.deleted_at IS NULL) AS folderCount,
      EXISTS(SELECT 1 FROM cloud_folder_unlocks u WHERE u.folder_id = f.id AND u.session_id = ? AND u.expires_at > ?) AS isUnlocked
    FROM cloud_folders f
    WHERE ${folderClauses.join(" AND ")}
    ORDER BY f.name COLLATE NOCASE ASC
  `).bind(...folderValues).all();

  const orderBySort = {
    "updated-desc": "updated_at DESC", "updated-asc": "updated_at ASC",
    "name-asc": "original_name COLLATE NOCASE ASC", "name-desc": "original_name COLLATE NOCASE DESC",
    "size-desc": "size_bytes DESC", "size-asc": "size_bytes ASC",
    newest: "created_at DESC", oldest: "created_at ASC", name: "original_name COLLATE NOCASE ASC", size: "size_bytes DESC"
  };
  const order = orderBySort[sort];
  let files = { results: [] };
  if (folderId && !foldersOnly) {
    const clauses = ["folder_id = ?", "deleted_at IS NULL", "status = 'ready'"];
    const values = [folderId];
    if (query) { clauses.push("(crypto_version = 1 OR LOWER(original_name) LIKE ?)"); values.push(`%${query}%`); }
    if (kind) { clauses.push("(crypto_version = 1 OR media_kind = ?)"); values.push(kind); }
    const uploadPageSize = 500;
    files = await env.DB.prepare(`
      SELECT id, folder_id AS folderId, original_name AS name, mime_type AS mimeType,
        media_kind AS mediaKind, size_bytes AS sizeBytes,
        crypto_version AS cryptoVersion, encrypted_metadata AS encryptedMetadata,
        metadata_iv AS metadataIv, wrapped_file_key AS wrappedFileKey, file_key_iv AS fileKeyIv,
        encrypted_size_bytes AS encryptedSizeBytes, chunk_size_bytes AS chunkSizeBytes,
        chunk_count AS chunkCount,
        thumbnail_key IS NOT NULL AS hasThumbnail,
        EXISTS(SELECT 1 FROM cloud_deletion_requests dr WHERE dr.file_id = cloud_files.id AND dr.status = 'pending') AS deletionPending,
        created_at AS createdAt, updated_at AS updatedAt
      FROM cloud_files WHERE ${clauses.join(" AND ")} ORDER BY ${order}${uploadIndex ? ", id ASC" : ""}
      LIMIT ${uploadIndex ? uploadPageSize + 1 : uploadPageSize} OFFSET ${uploadOffset}
    `).bind(...values).all();
  }
  const fileResults = files.results || [];
  const visibleFiles = uploadIndex ? fileResults.slice(0, 500) : fileResults;
  const nextFileOffset = uploadIndex && fileResults.length > 500 ? uploadOffset + 500 : null;
  const visibleFolders = (folders.results || []).map((item) => ({
    ...item,
    isUnlocked: session.role === "admin" ? 1 : item.isUnlocked,
    adminAccess: session.role === "admin"
  }));
  const canTrashContents = Boolean(folderId && (session.canDelete
    || (session.canTrashUnlockedFiles && folderAccessGranted)));
  return json({
    folder,
    canTrashContents,
    breadcrumbs: await breadcrumbs(env, folderId, session),
    folders: visibleFolders,
    files: visibleFiles,
    nextFileOffset
  });
}

async function loadConflictFolderRecords(env, folderIds) {
  const uniqueFolderIds = [...new Set(folderIds.map(Number).filter(Boolean))];
  const folders = new Map();
  for (let start = 0; start < uniqueFolderIds.length; start += 75) {
    const batch = uniqueFolderIds.slice(start, start + 75);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await env.DB.prepare(`WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, name, crypto_version, encrypted_name, name_iv,
          password_salt, password_wrapped_key, password_wrap_iv,
          admin_wrapped_key, parent_wrapped_key, parent_wrap_iv
        FROM cloud_folders WHERE id IN (${placeholders}) AND deleted_at IS NULL
        UNION
        SELECT parent.id, parent.parent_id, parent.name, parent.crypto_version,
          parent.encrypted_name, parent.name_iv, parent.password_salt,
          parent.password_wrapped_key, parent.password_wrap_iv,
          parent.admin_wrapped_key, parent.parent_wrapped_key, parent.parent_wrap_iv
        FROM cloud_folders parent JOIN ancestors child ON parent.id = child.parent_id
        WHERE parent.deleted_at IS NULL
      )
      SELECT id, parent_id AS parentId, name, crypto_version AS cryptoVersion,
        encrypted_name AS encryptedName, name_iv AS nameIv,
        password_salt AS passwordSalt, password_wrapped_key AS passwordWrappedKey,
        password_wrap_iv AS passwordWrapIv, admin_wrapped_key AS adminWrappedKey,
        parent_wrapped_key AS parentWrappedKey, parent_wrap_iv AS parentWrapIv
      FROM ancestors ORDER BY id ASC`).bind(...batch).all();
    for (const folder of result.results || []) folders.set(Number(folder.id), folder);
  }
  return [...folders.values()];
}

async function listUploadConflictCandidates(request, env, session) {
  requireUpload(session);
  const body = await readJson(request, 16384);
  const sizes = [...new Set((Array.isArray(body.sizes) ? body.sizes : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!sizes.length || sizes.length > 50) throw new HttpError(400, "確認するファイル容量を1〜50件で指定してください。");
  const scopeFolderId = optionalId(body.scopeFolderId);
  let scopeTopFolderId = null;
  if (scopeFolderId) {
    await requireFolder(env, scopeFolderId);
    await requireFolderAccess(env, scopeFolderId, session);
    const scopeResult = await env.DB.prepare(`WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id FROM cloud_folders parent
        JOIN ancestors child ON child.parent_id = parent.id
        WHERE parent.deleted_at IS NULL
      ) SELECT id FROM ancestors WHERE parent_id IS NULL LIMIT 1`).bind(scopeFolderId).first();
    scopeTopFolderId = Number(scopeResult?.id || 0) || null;
  }
  const offset = Math.min(100000, Math.max(0, Number.parseInt(body.offset || "0", 10) || 0));
  const pageSize = 200;
  const sizePlaceholders = sizes.map(() => "?").join(", ");
  const select = `SELECT f.id, f.folder_id AS folderId,
      CASE WHEN f.crypto_version = 1 THEN '' ELSE f.original_name END AS name,
      f.size_bytes AS sizeBytes, f.crypto_version AS cryptoVersion,
      f.encrypted_metadata AS encryptedMetadata, f.metadata_iv AS metadataIv,
      f.wrapped_file_key AS wrappedFileKey, f.file_key_iv AS fileKeyIv,
      f.created_at AS createdAt, f.updated_at AS updatedAt
    FROM cloud_files f`;
  let query;
  let values;
  if (session.role === "admin") {
    query = `WITH RECURSIVE folder_scope(id) AS (
        SELECT id FROM cloud_folders WHERE id = COALESCE(?, id) AND parent_id IS NULL AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child JOIN folder_scope parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      ) ${select}
      WHERE f.folder_id IN (SELECT id FROM folder_scope)
        AND f.deleted_at IS NULL AND f.status = 'ready' AND f.size_bytes IN (${sizePlaceholders})
      ORDER BY f.id ASC LIMIT ? OFFSET ?`;
    values = [scopeTopFolderId, ...sizes, pageSize + 1, offset];
  } else {
    const now = Math.floor(Date.now() / 1000);
    query = `WITH RECURSIVE folder_access(id, top_folder_id, is_allowed, has_protected_ancestor) AS (
        SELECT folder.id, folder.id,
          CASE WHEN folder.password_hash IS NULL THEN 1 ELSE EXISTS (
            SELECT 1 FROM cloud_folder_unlocks unlock
            WHERE unlock.folder_id = folder.id AND unlock.session_id = ? AND unlock.expires_at > ?
          ) END,
          CASE WHEN folder.password_hash IS NULL THEN 0 ELSE 1 END
        FROM cloud_folders folder
        WHERE folder.parent_id IS NULL AND folder.deleted_at IS NULL
        UNION
        SELECT child.id, parent.top_folder_id,
          parent.is_allowed AND (child.password_hash IS NULL OR EXISTS (
            SELECT 1 FROM cloud_folder_unlocks unlock
            WHERE unlock.folder_id = child.id AND unlock.session_id = ? AND unlock.expires_at > ?
          )),
          parent.has_protected_ancestor OR child.password_hash IS NOT NULL
        FROM cloud_folders child
        JOIN folder_access parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      )
      ${select}
      WHERE f.folder_id IN (
        SELECT id FROM folder_access
        WHERE is_allowed = 1 AND has_protected_ancestor = 1
          AND (? IS NULL OR top_folder_id = ?)
      )
        AND f.deleted_at IS NULL AND f.status = 'ready' AND f.size_bytes IN (${sizePlaceholders})
      ORDER BY f.id ASC LIMIT ? OFFSET ?`;
    values = [session.sessionId, now, session.sessionId, now, scopeTopFolderId, scopeTopFolderId, ...sizes, pageSize + 1, offset];
  }
  const result = await env.DB.prepare(query).bind(...values).all();
  const rows = result.results || [];
  const candidates = rows.slice(0, pageSize);
  const folderIds = [...new Set(candidates.map((file) => Number(file.folderId)).filter(Boolean))];
  const folders = await loadConflictFolderRecords(env, folderIds);
  return json({
    candidates,
    folders,
    nextOffset: rows.length > pageSize ? offset + pageSize : null
  });
}

async function listStoredConflictCandidates(url, env, session) {
  const offset = Math.min(100000, Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0));
  const pageSize = 300;
  const selectFields = (alias) => `${alias}.id, ${alias}.folder_id AS folderId,
      CASE WHEN ${alias}.crypto_version = 1 THEN '' ELSE ${alias}.original_name END AS name,
      ${alias}.mime_type AS mimeType, ${alias}.media_kind AS mediaKind,
      ${alias}.size_bytes AS sizeBytes, ${alias}.crypto_version AS cryptoVersion,
      ${alias}.encrypted_metadata AS encryptedMetadata, ${alias}.metadata_iv AS metadataIv,
      ${alias}.wrapped_file_key AS wrappedFileKey, ${alias}.file_key_iv AS fileKeyIv,
      ${alias}.created_at AS createdAt, ${alias}.updated_at AS updatedAt`;
  let query;
  let values;
  if (session.role === "admin") {
    query = `WITH RECURSIVE folder_scope(id, top_folder_id) AS (
        SELECT id, id FROM cloud_folders
        WHERE parent_id IS NULL AND deleted_at IS NULL
        UNION ALL
        SELECT child.id, parent.top_folder_id
        FROM cloud_folders child
        JOIN folder_scope parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      )
      SELECT ${selectFields("f")}, scope.top_folder_id AS topFolderId
      FROM cloud_files f
      JOIN folder_scope scope ON scope.id = f.folder_id
      WHERE f.deleted_at IS NULL AND f.status = 'ready' AND f.size_bytes > 0
      ORDER BY scope.top_folder_id ASC, f.id ASC LIMIT ? OFFSET ?`;
    values = [pageSize + 1, offset];
  } else {
    const now = Math.floor(Date.now() / 1000);
    query = `WITH RECURSIVE folder_access(id, top_folder_id, is_allowed, has_protected_ancestor) AS (
        SELECT folder.id, folder.id,
          CASE WHEN folder.password_hash IS NULL THEN 1 ELSE EXISTS (
            SELECT 1 FROM cloud_folder_unlocks unlock
            WHERE unlock.folder_id = folder.id AND unlock.session_id = ? AND unlock.expires_at > ?
          ) END,
          CASE WHEN folder.password_hash IS NULL THEN 0 ELSE 1 END
        FROM cloud_folders folder
        WHERE folder.parent_id IS NULL AND folder.deleted_at IS NULL
        UNION
        SELECT child.id, parent.top_folder_id,
          parent.is_allowed AND (child.password_hash IS NULL OR EXISTS (
            SELECT 1 FROM cloud_folder_unlocks unlock
            WHERE unlock.folder_id = child.id AND unlock.session_id = ? AND unlock.expires_at > ?
          )),
          parent.has_protected_ancestor OR child.password_hash IS NOT NULL
        FROM cloud_folders child
        JOIN folder_access parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      )
      SELECT ${selectFields("file")}, access.top_folder_id AS topFolderId
      FROM cloud_files file
      JOIN folder_access access ON access.id = file.folder_id
      WHERE access.is_allowed = 1 AND access.has_protected_ancestor = 1
        AND file.deleted_at IS NULL AND file.status = 'ready' AND file.size_bytes > 0
      ORDER BY access.top_folder_id ASC, file.id ASC LIMIT ? OFFSET ?`;
    values = [session.sessionId, now, session.sessionId, now, pageSize + 1, offset];
  }
  const result = await env.DB.prepare(query).bind(...values).all();
  const rows = result.results || [];
  const candidates = rows.slice(0, pageSize);
  const folderIds = [...new Set(candidates.map((file) => Number(file.folderId)).filter(Boolean))];
  const folders = await loadConflictFolderRecords(env, folderIds);
  return json({ candidates, folders, nextOffset: rows.length > pageSize ? offset + pageSize : null });
}

async function listLegacyFolders(env, session) {
  requireAdmin(session);
  const result = await env.DB.prepare(`
    SELECT id, parent_id AS parentId, name,
      crypto_version AS cryptoVersion, encrypted_name AS encryptedName, name_iv AS nameIv,
      admin_wrapped_key AS adminWrappedKey
    FROM cloud_folders
    WHERE deleted_at IS NULL
      AND crypto_version = 1
      AND (name IS NULL OR TRIM(name) = '' OR name = '[encrypted]')
    ORDER BY id ASC
    LIMIT 5000
  `).all();
  return json({ folders: result.results || [] });
}

async function createFolder(request, env, session) {
  requireUpload(session);
  const body = await readJson(request, 8192);
  const name = validName(body.name);
  const parentId = optionalId(body.parentId);
  if (!parentId && !body.authProof) throw new HttpError(400, "最上位フォルダにはパスワードが必要です。");
  if (parentId) {
    await requireFolder(env, parentId);
    await requireFolderAccess(env, parentId, session);
  }
  if (Number(body.cryptoVersion) !== 1) throw new HttpError(400, "暗号化されたフォルダ情報が必要です。");
  const encrypted = normalizeEncryptedFolder(body, false);
  const parent = normalizeParentWrappedFolder(body, Boolean(parentId));
  const passwordHash = encrypted.authProof ? await hashPassword(encrypted.authProof) : null;
  const result = await env.DB.prepare(`INSERT INTO cloud_folders
    (parent_id, name, password_hash, created_by, crypto_version, encrypted_name, name_iv,
      password_salt, password_wrapped_key, password_wrap_iv, admin_wrapped_key,
      parent_wrapped_key, parent_wrap_iv)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(parentId, name, passwordHash, session.role, encrypted.encryptedName, encrypted.nameIv,
      encrypted.passwordSalt, encrypted.passwordWrappedKey, encrypted.passwordWrapIv, encrypted.adminWrappedKey,
      parent.parentWrappedKey, parent.parentWrapIv).run();
  const id = Number(result.meta.last_row_id);
  await rememberFolderUnlock(env, session, id);
  await audit(env, "folder_created", session, "folder", id, { encrypted: true, folderNameEncrypted: false, protected: Boolean(passwordHash), inheritedProtection: Boolean(parentId && !passwordHash) });
  return json({ ok: true, id }, 201);
}

async function updateFolder(id, request, env, session) {
  requireFolderEdit(session);
  const folder = await requireFolder(env, id);
  const unlocked = await requireFolderAccess(env, id, session);
  const body = await readJson(request, 8192);
  const name = validName(body.name);
  const moving = Object.prototype.hasOwnProperty.call(body, "parentId");
  const parentId = moving ? optionalId(body.parentId) : folder.parent_id;
  const passwordAction = body.passwordAction === "replace" ? "replace" : "keep";
  if (!session.canEditFolders) {
    if (!unlocked) throw new HttpError(403, "PWで解除したフォルダ内の名前だけ変更できます。");
    if (moving) await requireSameUnlockedMoveScope(env, id, parentId, session, true);
    if (passwordAction === "replace" && !folder.password_hash) {
      throw new HttpError(403, "副管理者はPWで解除した保護フォルダのPWだけ変更できます。");
    }
  }
  let parentPackage = null;
  if (moving) {
    if (parentId) {
      await requireFolder(env, parentId);
      await requireFolderAccess(env, parentId, session);
      await ensureValidFolderMove(env, id, parentId);
      parentPackage = normalizeParentWrappedFolder(body, true);
    } else {
      if (!folder.password_hash) throw new HttpError(400, "個別PWがない配下フォルダは、PWを設定してから最上位へ移動してください。");
      parentPackage = normalizeParentWrappedFolder(body, false);
    }
  }
  if (passwordAction === "replace") {
    if (folder.parent_id && !folder.password_hash) throw new HttpError(400, "個別PWがない配下フォルダでは、作成後にPWを追加できません。");
    const authProof = validCryptoText(body.authProof, 256, "フォルダ認証");
    const passwordSalt = validCryptoText(body.passwordSalt, 128, "フォルダSalt");
    const passwordWrappedKey = validCryptoText(body.passwordWrappedKey, 512, "フォルダ鍵");
    const passwordWrapIv = validCryptoText(body.passwordWrapIv, 64, "フォルダ鍵IV");
    const passwordHash = await hashPassword(authProof);
    await env.DB.prepare(`UPDATE cloud_folders SET name = ?, password_hash = ?,
      password_salt = ?, password_wrapped_key = ?, password_wrap_iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(name, passwordHash, passwordSalt, passwordWrappedKey, passwordWrapIv, id).run();
    await rememberFolderUnlock(env, session, id);
  } else {
    await env.DB.prepare("UPDATE cloud_folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(name, id).run();
  }
  if (moving) {
    await env.DB.prepare(`UPDATE cloud_folders SET parent_id = ?, parent_wrapped_key = ?, parent_wrap_iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(parentId, parentPackage.parentWrappedKey, parentPackage.parentWrapIv, id).run();
  }
  await audit(env, "folder_updated", session, "folder", id, { folderNameEncrypted: false, passwordChanged: passwordAction === "replace", moved: moving, parentId });
  return json({ ok: true });
}

async function deleteFolder(id, env, session) {
  const folder = await requireFolder(env, id);
  if (session.canDelete) {
    await requireFolderAccess(env, id, session);
  } else {
    if (!session.canTrashUnlockedFiles || !folder.parent_id) {
      throw new HttpError(403, "PWで解除した最初のフォルダ配下だけ削除できます。");
    }
    const parentProtectedFolderUnlocked = await requireFolderAccess(env, folder.parent_id, session);
    if (!parentProtectedFolderUnlocked) {
      throw new HttpError(403, "PWで解除した最初のフォルダ配下だけ削除できます。");
    }
    await requireFolderAccess(env, id, session);
  }
  const deletedAt = new Date().toISOString();
  const summary = await env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
      SELECT id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL
      UNION ALL
      SELECT child.id FROM cloud_folders child
      JOIN folder_tree parent ON child.parent_id = parent.id
      WHERE child.deleted_at IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM folder_tree) AS folderCount,
      (SELECT COUNT(*) FROM cloud_files WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL) AS fileCount`)
    .bind(id).first();
  const folderCount = Number(summary?.folderCount || 0);
  const fileCount = Number(summary?.fileCount || 0);
  if (!folderCount) throw new HttpError(404, "フォルダが見つかりません。");
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child
        JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      )
      UPDATE cloud_files SET deleted_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE deleted_at IS NULL AND folder_id IN (SELECT id FROM folder_tree)`).bind(id, deletedAt),
    env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child
        JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.deleted_at IS NULL
      )
      UPDATE cloud_folders SET deleted_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM folder_tree)`).bind(id, deletedAt)
  ]);
  await audit(env, "folder_trashed", session, "folder", id, { folderCount, fileCount });
  return json({ ok: true, folderCount, fileCount, deleted: folderCount + fileCount });
}

async function restoreFolder(id, env, session) {
  requireDelete(session);
  const folder = await env.DB.prepare("SELECT id, deleted_at AS deletedAt FROM cloud_folders WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
  if (!folder) throw new HttpError(404, "ゴミ箱にフォルダが見つかりません。");
  const summary = await env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
      SELECT id FROM cloud_folders WHERE id = ? AND deleted_at = ?
      UNION ALL
      SELECT child.id FROM cloud_folders child
      JOIN folder_tree parent ON child.parent_id = parent.id
      WHERE child.deleted_at = ?
    )
    SELECT
      (SELECT COUNT(*) FROM folder_tree) AS folderCount,
      (SELECT COUNT(*) FROM cloud_files WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at = ?) AS fileCount`)
    .bind(id, folder.deletedAt, folder.deletedAt, folder.deletedAt).first();
  const folderCount = Number(summary?.folderCount || 0);
  const fileCount = Number(summary?.fileCount || 0);
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND deleted_at = ?
        UNION ALL
        SELECT child.id FROM cloud_folders child
        JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.deleted_at = ?
      )
      UPDATE cloud_files SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE deleted_at = ? AND folder_id IN (SELECT id FROM folder_tree)`)
      .bind(id, folder.deletedAt, folder.deletedAt, folder.deletedAt),
    env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND deleted_at = ?
        UNION ALL
        SELECT child.id FROM cloud_folders child
        JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.deleted_at = ?
      )
      UPDATE cloud_folders SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM folder_tree)`)
      .bind(id, folder.deletedAt, folder.deletedAt)
  ]);
  await audit(env, "folder_restored", session, "folder", id, { folderCount, fileCount });
  return json({ ok: true, folderCount, fileCount, restored: folderCount + fileCount });
}

async function unlockFolder(id, request, env, session) {
  const folder = await env.DB.prepare(`SELECT id, password_hash, crypto_version AS cryptoVersion,
    encrypted_name AS encryptedName, name_iv AS nameIv, password_salt AS passwordSalt,
    password_wrapped_key AS passwordWrappedKey, password_wrap_iv AS passwordWrapIv,
    admin_wrapped_key AS adminWrappedKey FROM cloud_folders WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!folder) throw new HttpError(404, "フォルダが見つかりません。");
  if (!folder.password_hash) return json({ ok: true });
  const body = await readJson(request, 8192);
  const proof = Number(folder.cryptoVersion) === 1
    ? validCryptoText(body.authProof, 256, "フォルダ認証")
    : normalizeFolderPassword(body.password, true);
  if (!(await verifyPassword(proof, folder.password_hash))) throw new HttpError(401, "フォルダのパスワードが違います。");
  await rememberFolderUnlock(env, session, id);
  await audit(env, "folder_unlocked", session, "folder", id);
  return json({ ok: true, folder });
}

async function createUpload(request, env, session) {
  requireUpload(session);
  const body = await readJson(request, 16384);
  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new HttpError(400, "空ファイル（0バイト）はアップロード対象外です。");
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new HttpError(413, "現在のアップロード方式では1ファイル最大約640GBです。");
  }
  if (Number(body.cryptoVersion) !== 1) throw new HttpError(400, "暗号化されたファイルだけ保存できます。");
  const encrypted = normalizeEncryptedFile(body, sizeBytes);
  const folderId = optionalId(body.folderId);
  if (!folderId) throw new HttpError(400, "ファイルはPW付きフォルダ内に保存してください。");
  await requireFolder(env, folderId);
  await requireFolderAccess(env, folderId, session);
  const objectKey = `originals/${crypto.randomUUID()}`;
  const upload = await env.FILES.createMultipartUpload(objectKey, { httpMetadata: { contentType: "application/octet-stream" } });
  const result = await env.DB.prepare(`
    INSERT INTO cloud_files (folder_id, object_key, original_name, mime_type, media_kind, size_bytes,
      multipart_upload_id, created_by, crypto_version, encrypted_metadata, metadata_iv,
      wrapped_file_key, file_key_iv, encrypted_size_bytes, chunk_size_bytes, chunk_count)
    VALUES (?, ?, '[encrypted]', 'application/octet-stream', 'other', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).bind(folderId, objectKey, sizeBytes, upload.uploadId, session.role, encrypted.encryptedMetadata,
    encrypted.metadataIv, encrypted.wrappedFileKey, encrypted.fileKeyIv, encrypted.encryptedSizeBytes,
    encrypted.chunkSizeBytes, encrypted.chunkCount).run();
  const id = Number(result.meta.last_row_id);
  await audit(env, "upload_started", session, "file", id, { encrypted: true, sizeBytes });
  return json({ id, uploadId: upload.uploadId, chunkSize: encrypted.chunkSizeBytes }, 201);
}

async function uploadPart(id, partNumber, request, env, session) {
  requireUpload(session);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new HttpError(400, "分割番号が不正です。");
  const file = await requireUploadingFile(env, id);
  requireUploadOwnership(session, file);
  const upload = env.FILES.resumeMultipartUpload(file.object_key, file.multipart_upload_id);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(id, request, env, session) {
  requireUpload(session);
  const body = await readJson(request, 1000000);
  if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 10000) throw new HttpError(400, "アップロード情報が不正です。");
  const parts = body.parts.map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag || "") }));
  const file = await requireUploadingFile(env, id);
  requireUploadOwnership(session, file);
  const upload = env.FILES.resumeMultipartUpload(file.object_key, file.multipart_upload_id);
  await upload.complete(parts);
  const stored = await env.FILES.head(file.object_key);
  const expectedBytes = Number(file.encrypted_size_bytes || 0);
  const storedBytes = Number(stored?.size || 0);
  if (!stored || storedBytes !== expectedBytes) {
    await env.FILES.delete(file.object_key).catch(() => {});
    await env.DB.prepare("DELETE FROM cloud_files WHERE id = ? AND status = 'uploading'").bind(id).run();
    throw new HttpError(502, "Cloudflare上の保存容量を確認できませんでした。最初から再試行します。");
  }
  await env.DB.prepare("UPDATE cloud_files SET status = 'ready', multipart_upload_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  await audit(env, "upload_completed", session, "file", id, { encrypted: Number(file.crypto_version) === 1, sizeBytes: file.size_bytes });
  return json({ ok: true, id, verified: true, storedBytes });
}

async function cancelUpload(id, env, session) {
  requireUpload(session);
  const file = await requireUploadingFile(env, id);
  requireUploadOwnership(session, file);
  await env.FILES.resumeMultipartUpload(file.object_key, file.multipart_upload_id).abort();
  await env.DB.prepare("DELETE FROM cloud_files WHERE id = ? AND status = 'uploading'").bind(id).run();
  return json({ ok: true });
}

async function getFile(id, env, session) {
  const file = await requireReadyFile(env, id, true);
  requireTrashVisibility(session, file);
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  return json({ file: mapFile(file) });
}

async function updateFile(id, request, env, session) {
  requireFileEdit(session);
  const file = await requireReadyFile(env, id, false);
  const unlocked = file.folder_id ? await requireFolderAccess(env, file.folder_id, session) : false;
  const body = await readJson(request, 16384);
  const moving = Object.prototype.hasOwnProperty.call(body, "folderId");
  if (!session.canEditFiles) {
    if (!unlocked) throw new HttpError(403, "PWで解除したフォルダ内のファイル名だけ変更できます。");
    if (moving) await requireSameUnlockedMoveScope(env, file.folder_id, optionalId(body.folderId), session, false);
  }
  if (Number(file.crypto_version) === 1) {
    const encryptedMetadata = body.encryptedMetadata === undefined ? file.encrypted_metadata : validCryptoText(body.encryptedMetadata, 4096, "ファイル情報");
    const metadataIv = body.metadataIv === undefined ? file.metadata_iv : validCryptoText(body.metadataIv, 64, "ファイル情報IV");
    const folderId = moving ? optionalId(body.folderId) : file.folder_id;
    if (!folderId) throw new HttpError(400, "ファイルはPW付きフォルダ内に保存してください。");
    if (moving) {
      await requireFolder(env, folderId);
      await requireFolderAccess(env, folderId, session);
    }
    const wrappedFileKey = moving ? validCryptoText(body.wrappedFileKey, 512, "ファイル鍵") : file.wrapped_file_key;
    const fileKeyIv = moving ? validCryptoText(body.fileKeyIv, 64, "ファイル鍵IV") : file.file_key_iv;
    await env.DB.prepare("UPDATE cloud_files SET encrypted_metadata = ?, metadata_iv = ?, folder_id = ?, wrapped_file_key = ?, file_key_iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(encryptedMetadata, metadataIv, folderId, wrappedFileKey, fileKeyIv, id).run();
    await audit(env, "file_updated", session, "file", id, { encrypted: true, moved: moving, folderId });
    return json({ ok: true });
  }
  const name = body.name === undefined ? file.original_name : validName(body.name);
  const folderId = body.folderId === undefined ? file.folder_id : optionalId(body.folderId);
  if (folderId) {
    await requireFolder(env, folderId);
    await requireFolderAccess(env, folderId, session);
  }
  if (!folderId) throw new HttpError(400, "ファイルはPW付きフォルダ内に保存してください。");
  await env.DB.prepare("UPDATE cloud_files SET original_name = ?, folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, folderId, id).run();
  await audit(env, "file_updated", session, "file", id, { name, folderId });
  return json({ ok: true });
}

async function moveFileToTrash(id, env, session) {
  const file = await requireReadyFile(env, id, false);
  if (session.canDelete) {
    if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  } else {
    if (!session.canTrashUnlockedFiles || !file.folder_id) throw new HttpError(403, "このファイルは削除できません。");
    const protectedFolderUnlocked = await requireFolderAccess(env, file.folder_id, session);
    if (!protectedFolderUnlocked) throw new HttpError(403, "PWで解除したフォルダ内のファイルだけ削除できます。");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE cloud_files SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE cloud_deletion_requests SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = ? WHERE file_id = ? AND status = 'pending'").bind(session.role, id)
  ]);
  await audit(env, "file_trashed", session, "file", id);
  return json({ ok: true });
}

async function restoreFile(id, env, session) {
  requireDelete(session);
  const file = await env.DB.prepare("SELECT id, folder_id FROM cloud_files WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
  if (!file) throw new HttpError(404, "ゴミ箱にファイルが見つかりません。");
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  await env.DB.prepare("UPDATE cloud_files SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  await audit(env, "file_restored", session, "file", id);
  return json({ ok: true });
}

async function permanentlyDeleteFile(id, env, session) {
  requireDelete(session);
  const file = await env.DB.prepare("SELECT object_key, thumbnail_key, stream_uid FROM cloud_files WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
  if (!file) throw new HttpError(404, "ゴミ箱にファイルが見つかりません。");
  await env.FILES.delete(file.object_key);
  if (file.thumbnail_key) await env.FILES.delete(file.thumbnail_key);
  if (file.stream_uid && env.STREAM) await env.STREAM.video(file.stream_uid).delete();
  await env.DB.prepare("DELETE FROM cloud_files WHERE id = ?").bind(id).run();
  await audit(env, "file_deleted", session, "file", id);
  return json({ ok: true });
}

async function emptyTrash(env, session) {
  requireDelete(session);
  const totals = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM cloud_files WHERE deleted_at IS NOT NULL) AS fileCount,
    (SELECT COUNT(*) FROM cloud_folders WHERE deleted_at IS NOT NULL) AS folderCount`).first();
  const rows = await env.DB.prepare("SELECT id, object_key, thumbnail_key, stream_uid FROM cloud_files WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 20").all();
  let deleted = 0;
  let deletedFolders = 0;
  let failed = 0;
  for (const file of rows.results || []) {
    try {
      await env.FILES.delete(file.object_key);
      if (file.thumbnail_key) await env.FILES.delete(file.thumbnail_key);
      if (file.stream_uid && env.STREAM) await env.STREAM.video(file.stream_uid).delete();
      await env.DB.prepare("DELETE FROM cloud_files WHERE id = ? AND deleted_at IS NOT NULL").bind(file.id).run();
      await audit(env, "file_deleted", session, "file", file.id, { bulk: true });
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  const remainingRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM cloud_files WHERE deleted_at IS NOT NULL").first();
  const remaining = Number(remainingRow?.count || 0);
  if (failed === 0 && remaining === 0) {
    try {
      const result = await env.DB.prepare("DELETE FROM cloud_folders WHERE deleted_at IS NOT NULL").run();
      deletedFolders = Number(result.meta?.changes || 0);
    } catch {
      failed += 1;
    }
  }
  return json({
    ok: failed === 0 && remaining === 0,
    deleted,
    deletedFolders,
    failed,
    remaining,
    totalFiles: Number(totals?.fileCount || 0),
    totalFolders: Number(totals?.folderCount || 0)
  });
}

async function putThumbnail(id, request, env, session) {
  requireUpload(session);
  const file = await requireReadyFile(env, id, false);
  if (session.role !== "admin") {
    const completedAt = Date.parse(`${file.updated_at}Z`);
    const isFreshOwnUpload = file.created_by === session.role && !file.thumbnail_key && Number.isFinite(completedAt) && Date.now() - completedAt < 60 * 60 * 1000;
    if (!isFreshOwnUpload) throw new HttpError(403, "副管理者は既存ファイルのサムネイルを変更できません。");
  }
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 2 * 1024 * 1024) throw new HttpError(413, "サムネイルが大きすぎます。");
  const key = file.thumbnail_key || `thumbnails/${crypto.randomUUID()}.webp`;
  await env.FILES.put(key, request.body, { httpMetadata: { contentType: Number(file.crypto_version) === 1 ? "application/octet-stream" : "image/webp" } });
  await env.DB.prepare("UPDATE cloud_files SET thumbnail_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(key, id).run();
  return json({ ok: true });
}

async function getThumbnail(id, env, session) {
  const file = await requireReadyFile(env, id, true);
  requireTrashVisibility(session, file);
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  if (!file.thumbnail_key) throw new HttpError(404, "サムネイルがありません。");
  const object = await env.FILES.get(file.thumbnail_key);
  if (!object) throw new HttpError(404, "サムネイルがありません。");
  return objectResponse(object, "inline", Number(file.crypto_version) === 1 ? "encrypted-thumbnail.bin" : "thumbnail.webp", Number(file.crypto_version) === 1 ? "application/octet-stream" : "image/webp");
}

async function streamFile(id, disposition, request, env, session) {
  const file = await requireReadyFile(env, id, true);
  requireTrashVisibility(session, file);
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  if (file.stream_uid && disposition === "view" && env.STREAM) {
    const token = await env.STREAM.video(file.stream_uid).generateToken({ expiresIn: 900 });
    return json({ streamToken: token, streamUid: file.stream_uid });
  }
  const rangeHeader = request.headers.get("Range");
  const object = await env.FILES.get(file.object_key, rangeHeader ? { range: request.headers } : undefined);
  if (!object) throw new HttpError(404, "ファイルが見つかりません。");
  const encrypted = Number(file.crypto_version) === 1;
  return objectResponse(object, disposition === "download" ? "attachment" : "inline", encrypted ? "encrypted-file.bin" : file.original_name, encrypted ? "application/octet-stream" : file.mime_type, rangeHeader);
}

async function listTrash(env, session) {
  requireDelete(session);
  const result = await env.DB.prepare(`
    SELECT f.id, f.folder_id AS folderId, f.original_name AS name, f.mime_type AS mimeType, f.media_kind AS mediaKind,
      f.size_bytes AS sizeBytes, f.thumbnail_key IS NOT NULL AS hasThumbnail, f.deleted_at AS deletedAt,
      f.crypto_version AS cryptoVersion, f.encrypted_metadata AS encryptedMetadata, f.metadata_iv AS metadataIv,
      f.wrapped_file_key AS wrappedFileKey, f.file_key_iv AS fileKeyIv,
      f.encrypted_size_bytes AS encryptedSizeBytes, f.chunk_size_bytes AS chunkSizeBytes, f.chunk_count AS chunkCount,
      fo.crypto_version AS folderCryptoVersion, fo.encrypted_name AS folderEncryptedName, fo.name_iv AS folderNameIv,
      fo.password_salt AS folderPasswordSalt, fo.password_wrapped_key AS folderPasswordWrappedKey,
      fo.password_wrap_iv AS folderPasswordWrapIv, fo.admin_wrapped_key AS folderAdminWrappedKey
    FROM cloud_files f JOIN cloud_folders fo ON fo.id = f.folder_id
    WHERE f.folder_id IS NOT NULL AND f.deleted_at IS NOT NULL AND fo.deleted_at IS NULL
    ORDER BY f.deleted_at DESC LIMIT 500
  `).all();
  const files = [];
  for (const file of result.results || []) {
    try {
      await requireFolderAccess(env, file.folderId, session);
      files.push(file);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 423) throw error;
    }
  }
  const folderResult = await env.DB.prepare(`SELECT f.id, f.parent_id AS parentId, f.name,
      f.created_at AS createdAt, f.updated_at AS updatedAt, f.deleted_at AS deletedAt,
      f.crypto_version AS cryptoVersion, f.encrypted_name AS encryptedName, f.name_iv AS nameIv,
      f.password_salt AS passwordSalt, f.password_wrapped_key AS passwordWrappedKey,
      f.password_wrap_iv AS passwordWrapIv, f.admin_wrapped_key AS adminWrappedKey,
      f.parent_wrapped_key AS parentWrappedKey, f.parent_wrap_iv AS parentWrapIv,
      f.password_hash IS NOT NULL AS isProtected
    FROM cloud_folders f
    LEFT JOIN cloud_folders parent ON parent.id = f.parent_id
    WHERE f.deleted_at IS NOT NULL
      AND (parent.id IS NULL OR parent.deleted_at IS NULL OR parent.deleted_at <> f.deleted_at)
    ORDER BY f.deleted_at DESC, f.id DESC LIMIT 500`).all();
  const folders = [];
  for (const folder of folderResult.results || []) {
    const summary = await env.DB.prepare(`WITH RECURSIVE folder_tree(id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND deleted_at = ?
        UNION ALL
        SELECT child.id FROM cloud_folders child
        JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.deleted_at = ?
      )
      SELECT
        (SELECT COUNT(*) FROM folder_tree) AS folderCount,
        (SELECT COUNT(*) FROM cloud_files WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at = ?) AS fileCount,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM cloud_files WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at = ?) AS sizeBytes`)
      .bind(folder.id, folder.deletedAt, folder.deletedAt, folder.deletedAt, folder.deletedAt).first();
    folders.push({
      ...folder,
      folderCount: Math.max(0, Number(summary?.folderCount || 1) - 1),
      fileCount: Number(summary?.fileCount || 0),
      sizeBytes: Number(summary?.sizeBytes || 0),
      isUnlocked: 1,
      adminAccess: true
    });
  }
  return json({ files, folders });
}

async function getUsage(env, session) {
  requireAdmin(session);
  const row = await env.DB.prepare(`SELECT
    SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS activeFileCount,
    COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN size_bytes ELSE 0 END), 0) AS activeBytes,
    SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashFileCount,
    COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN size_bytes ELSE 0 END), 0) AS trashBytes
    FROM cloud_files WHERE status = 'ready'`).first();
  return json({
    activeFileCount: Number(row?.activeFileCount || 0),
    activeBytes: Number(row?.activeBytes || 0),
    trashFileCount: Number(row?.trashFileCount || 0),
    trashBytes: Number(row?.trashBytes || 0)
  });
}

async function getUsageDetails(env, session) {
  requireAdmin(session);
  const result = await env.DB.prepare(`WITH RECURSIVE folder_tree(root_id, id) AS (
    SELECT id, id FROM cloud_folders WHERE parent_id IS NULL AND deleted_at IS NULL
    UNION ALL
    SELECT parent.root_id, child.id FROM cloud_folders child
    JOIN folder_tree parent ON child.parent_id = parent.id
    WHERE child.deleted_at IS NULL
  )
  SELECT root.id, root.name,
    COUNT(file.id) AS fileCount,
    COALESCE(SUM(file.size_bytes), 0) AS sizeBytes
  FROM cloud_folders root
  LEFT JOIN folder_tree tree ON tree.root_id = root.id
  LEFT JOIN cloud_files file ON file.folder_id = tree.id AND file.deleted_at IS NULL AND file.status = 'ready'
  WHERE root.parent_id IS NULL AND root.deleted_at IS NULL
  GROUP BY root.id, root.name
  ORDER BY sizeBytes DESC, root.name COLLATE NOCASE ASC`).all();
  return json({ folders: (result.results || []).map((folder) => ({
    id: Number(folder.id),
    name: folder.name,
    fileCount: Number(folder.fileCount || 0),
    sizeBytes: Number(folder.sizeBytes || 0)
  })) });
}

async function listUploadHistory(env, session) {
  requireHistory(session);
  const roleClause = session.role === "admin" ? "" : "AND l.actor_role = ?";
  const roleValues = session.role === "admin" ? [] : [session.role];
  const result = await env.DB.prepare(`
    SELECT l.event_type AS eventType, l.actor_role AS actorRole, l.target_id AS fileId, l.details_json AS detailsJson,
      l.occurred_at AS uploadedAt, f.original_name AS currentName, f.size_bytes AS currentSize,
      f.media_kind AS currentKind, f.deleted_at AS deletedAt, f.folder_id AS folderId,
      f.crypto_version AS cryptoVersion, f.encrypted_metadata AS encryptedMetadata,
      f.metadata_iv AS metadataIv, f.wrapped_file_key AS wrappedFileKey, f.file_key_iv AS fileKeyIv,
      fo.crypto_version AS folderCryptoVersion, fo.encrypted_name AS folderEncryptedName,
      fo.name_iv AS folderNameIv, fo.password_salt AS folderPasswordSalt,
      fo.password_wrapped_key AS folderPasswordWrappedKey, fo.password_wrap_iv AS folderPasswordWrapIv,
      fo.admin_wrapped_key AS folderAdminWrappedKey
    FROM cloud_audit_logs l
    LEFT JOIN cloud_files f ON f.id = l.target_id
    LEFT JOIN cloud_folders fo ON fo.id = f.folder_id
    WHERE l.event_type IN ('upload_completed', 'download_completed', 'download_failed') ${roleClause}
    ORDER BY l.occurred_at DESC, l.id DESC
    LIMIT 1000
  `).bind(...roleValues).all();
  const history = (result.results || []).map((row) => {
    let details = {};
    try { details = JSON.parse(row.detailsJson || "{}"); } catch {}
    return {
      fileId: row.fileId,
      name: details.name || row.currentName || "削除済みファイル",
      sizeBytes: Number(details.sizeBytes ?? row.currentSize ?? 0),
      mediaKind: details.mediaKind || row.currentKind || "other",
      uploadedAt: row.uploadedAt,
      folderId: row.folderId,
      cryptoVersion: row.cryptoVersion,
      encryptedMetadata: row.encryptedMetadata,
      metadataIv: row.metadataIv,
      wrappedFileKey: row.wrappedFileKey,
      fileKeyIv: row.fileKeyIv,
      folderCryptoVersion: row.folderCryptoVersion,
      folderEncryptedName: row.folderEncryptedName,
      folderNameIv: row.folderNameIv,
      folderPasswordSalt: row.folderPasswordSalt,
      folderPasswordWrappedKey: row.folderPasswordWrappedKey,
      folderPasswordWrapIv: row.folderPasswordWrapIv,
      folderAdminWrappedKey: row.folderAdminWrappedKey,
      actorRole: row.actorRole,
      actorLabel: row.actorRole === "subadmin" ? "副管理者" : "管理者",
      eventType: row.eventType,
      eventLabel: row.eventType === "upload_completed" ? "アップロード完了" : row.eventType === "download_failed" ? "ダウンロード失敗" : "ダウンロード完了",
      errorCode: details.errorCode || null,
      deleted: Boolean(row.deletedAt || !row.currentName)
    };
  });
  return json({ history });
}

async function recordDownloadEvent(request, env, session) {
  const body = await readJson(request, 4096);
  const fileId = optionalId(body.fileId);
  const eventType = ["download_started", "download_completed", "download_failed"].includes(body.eventType) ? body.eventType : "";
  if (!fileId || !eventType) throw new HttpError(400, "ダウンロード履歴を確認してください。");
  const file = await requireReadyFile(env, fileId, false);
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  const details = eventType === "download_failed" ? { errorCode: normalizeText(body.errorCode || "client_error", 80) } : null;
  await audit(env, eventType, session, "file", fileId, details);
  return json({ ok: true });
}

async function requestFileDeletion(id, env, session) {
  requireDeletionRequest(session);
  const file = await requireReadyFile(env, id, false);
  if (file.folder_id) await requireFolderAccess(env, file.folder_id, session);
  try {
    const result = await env.DB.prepare(`INSERT INTO cloud_deletion_requests (file_id, file_name, requested_by)
      VALUES (?, ?, ?)` ).bind(id, file.original_name, session.role).run();
    const requestId = Number(result.meta.last_row_id);
    await audit(env, "deletion_requested", session, "file", id, { requestId, name: file.original_name });
    return json({ ok: true, requestId, status: "pending" }, 201);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "このファイルは削除申請中です。");
    throw error;
  }
}

async function listDeletionRequests(env, session) {
  requireDeletionReview(session);
  const result = await env.DB.prepare(`
    SELECT r.id, r.file_id AS fileId, r.file_name AS requestedName, r.requested_by AS requestedBy,
      r.requested_at AS requestedAt, f.original_name AS currentName, f.size_bytes AS sizeBytes,
      f.media_kind AS mediaKind, f.deleted_at AS deletedAt, f.folder_id AS folderId,
      f.crypto_version AS cryptoVersion, f.encrypted_metadata AS encryptedMetadata,
      f.metadata_iv AS metadataIv, f.wrapped_file_key AS wrappedFileKey, f.file_key_iv AS fileKeyIv,
      fo.name AS folderName, fo.crypto_version AS folderCryptoVersion,
      fo.encrypted_name AS folderEncryptedName, fo.name_iv AS folderNameIv,
      fo.password_salt AS folderPasswordSalt, fo.password_wrapped_key AS folderPasswordWrappedKey,
      fo.password_wrap_iv AS folderPasswordWrapIv, fo.admin_wrapped_key AS folderAdminWrappedKey
    FROM cloud_deletion_requests r
    LEFT JOIN cloud_files f ON f.id = r.file_id
    LEFT JOIN cloud_folders fo ON fo.id = f.folder_id
    WHERE r.status = 'pending'
    ORDER BY r.requested_at ASC, r.id ASC
  `).all();
  const requests = (result.results || []).map((row) => ({
    id: row.id,
    fileId: row.fileId,
    name: row.currentName || row.requestedName,
    folderName: row.folderName || "—",
    sizeBytes: Number(row.sizeBytes || 0),
    mediaKind: row.mediaKind || "other",
    folderId: row.folderId,
    cryptoVersion: row.cryptoVersion,
    encryptedMetadata: row.encryptedMetadata,
    metadataIv: row.metadataIv,
    wrappedFileKey: row.wrappedFileKey,
    fileKeyIv: row.fileKeyIv,
    folderCryptoVersion: row.folderCryptoVersion,
    folderEncryptedName: row.folderEncryptedName,
    folderNameIv: row.folderNameIv,
    folderPasswordSalt: row.folderPasswordSalt,
    folderPasswordWrappedKey: row.folderPasswordWrappedKey,
    folderPasswordWrapIv: row.folderPasswordWrapIv,
    folderAdminWrappedKey: row.folderAdminWrappedKey,
    requestedBy: row.requestedBy === "subadmin" ? "副管理者" : row.requestedBy,
    requestedAt: row.requestedAt,
    unavailable: !row.fileId || Boolean(row.deletedAt)
  }));
  return json({ requests, count: requests.length });
}

async function approveDeletionRequest(id, env, session) {
  requireDeletionReview(session);
  const request = await env.DB.prepare(`SELECT r.id, r.file_id AS fileId, r.file_name AS fileName,
    f.deleted_at AS deletedAt FROM cloud_deletion_requests r
    LEFT JOIN cloud_files f ON f.id = r.file_id
    WHERE r.id = ? AND r.status = 'pending'`).bind(id).first();
  if (!request) throw new HttpError(404, "削除申請が見つかりません。");
  const statements = [
    env.DB.prepare("UPDATE cloud_deletion_requests SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = ? WHERE id = ? AND status = 'pending'").bind(session.role, id)
  ];
  if (request.fileId && !request.deletedAt) {
    statements.unshift(env.DB.prepare("UPDATE cloud_files SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").bind(request.fileId));
  }
  await env.DB.batch(statements);
  await audit(env, "deletion_approved", session, "file", request.fileId, { requestId: id, name: request.fileName });
  return json({ ok: true, movedToTrash: Boolean(request.fileId && !request.deletedAt) });
}

async function abortStaleUploads(env) {
  const stale = await env.DB.prepare("SELECT id, object_key, multipart_upload_id FROM cloud_files WHERE status = 'uploading' AND created_at < datetime('now', '-1 day') LIMIT 100").all();
  for (const file of stale.results || []) {
    try { await env.FILES.resumeMultipartUpload(file.object_key, file.multipart_upload_id).abort(); } catch {}
    await env.DB.prepare("DELETE FROM cloud_files WHERE id = ?").bind(file.id).run();
  }
  await env.DB.prepare("DELETE FROM cloud_folder_unlocks WHERE expires_at <= ?").bind(Math.floor(Date.now() / 1000)).run();
}

async function requireShareByToken(token, env, requireActive) {
  const cleanToken = normalizeShareToken(token);
  const tokenHash = await sha256Base64Url(cleanToken);
  const share = await env.DB.prepare("SELECT * FROM cloud_shares WHERE token_hash = ?").bind(tokenHash).first();
  if (!share) throw new HttpError(404, "共有URLが見つかりません。");
  if (requireActive) {
    const now = Math.floor(Date.now() / 1000);
    if (share.stopped_at) throw new HttpError(410, "この共有URLは停止されています。");
    if (Number(share.expires_at) <= now) throw new HttpError(410, "この共有URLの期限は終了しました。");
    const fileSetCount = await shareSelectionCount(env, share.id);
    const target = fileSetCount
      ? await env.DB.prepare(`SELECT 1 AS ok FROM cloud_share_files sf JOIN cloud_files f ON f.id = sf.file_id
        WHERE sf.share_id = ? AND f.deleted_at IS NULL AND f.status = 'ready' LIMIT 1`).bind(share.id).first()
      : share.target_type === "folder"
      ? await env.DB.prepare("SELECT 1 AS ok FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(share.target_id).first()
      : await env.DB.prepare("SELECT 1 AS ok FROM cloud_files WHERE id = ? AND deleted_at IS NULL AND status = 'ready'").bind(share.target_id).first();
    if (!target) throw new HttpError(410, "共有対象は利用できません。");
  }
  return share;
}

async function requireAuthorizedShare(token, request, env) {
  const share = await requireShareByToken(token, env, true);
  await readShareSession(request, env, share);
  return share;
}

async function createShareSessionToken(share, sessionId, maxAge, env) {
  const payload = {
    type: "share",
    shareId: Number(share.id),
    tokenHash: share.token_hash,
    sessionId,
    exp: Math.floor(Date.now() / 1000) + maxAge,
    version: String(env.SESSION_VERSION || "1")
  };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, env.SESSION_SECRET)}`;
}

async function readShareSession(request, env, share) {
  try {
    const token = readCookie(request, SHARE_SESSION_COOKIE);
    if (!token || !env.SESSION_SECRET) throw new Error();
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature || !(await constantTimeText(signature, await sign(encoded, env.SESSION_SECRET)))) throw new Error();
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    if (payload.type !== "share" || Number(payload.shareId) !== Number(share.id) || payload.tokenHash !== share.token_hash) throw new Error();
    if (payload.exp <= Math.floor(Date.now() / 1000) || String(payload.version) !== String(env.SESSION_VERSION || "1")) throw new Error();
    return payload;
  } catch {
    throw new HttpError(401, "共有パスワードを入力してください。");
  }
}

async function recordFailedShareUnlock(env, shareId, fingerprint, attempt, now) {
  const inWindow = attempt && now - Number(attempt.first_failed_at) <= LOGIN_WINDOW_SECONDS;
  const failedCount = inWindow ? Number(attempt.failed_count) + 1 : 1;
  const firstFailedAt = inWindow ? Number(attempt.first_failed_at) : now;
  const lockedUntil = failedCount >= LOGIN_LIMIT ? now + LOGIN_WINDOW_SECONDS : null;
  await env.DB.prepare(`INSERT INTO cloud_share_attempts
    (share_id, fingerprint, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(share_id, fingerprint) DO UPDATE SET failed_count = excluded.failed_count,
    first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`)
    .bind(shareId, fingerprint, failedCount, firstFailedAt, lockedUntil).run();
}

async function folderWithinShare(env, folderId, rootFolderId) {
  let current = folderId;
  let guard = 0;
  while (current && guard++ < 50) {
    if (Number(current) === Number(rootFolderId)) return true;
    const folder = await env.DB.prepare("SELECT parent_id AS parentId FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(current).first();
    if (!folder) return false;
    current = folder.parentId;
  }
  return false;
}

async function requireSharedFile(env, share, fileId) {
  const file = await requireReadyFile(env, fileId, false);
  const fileSetCount = await shareSelectionCount(env, share.id);
  if (fileSetCount) {
    const selected = await env.DB.prepare("SELECT 1 AS ok FROM cloud_share_files WHERE share_id = ? AND file_id = ?").bind(share.id, fileId).first();
    if (!selected) throw new HttpError(403, "共有範囲外のファイルです。");
    return file;
  }
  if (share.target_type === "file") {
    if (Number(file.id) !== Number(share.target_id)) throw new HttpError(403, "共有範囲外のファイルです。");
    return file;
  }
  if (!file.folder_id || !(await folderWithinShare(env, Number(file.folder_id), Number(share.target_id)))) {
    throw new HttpError(403, "共有範囲外のファイルです。");
  }
  return file;
}

async function shareSelectionCount(env, shareId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM cloud_share_files WHERE share_id = ?").bind(shareId).first();
  return Number(row?.count || 0);
}

function publicFolderRecord(folder) {
  return {
    id: Number(folder.id),
    parentId: folder.parentId ?? folder.parent_id ?? null,
    name: folder.name,
    cryptoVersion: folder.cryptoVersion ?? folder.crypto_version,
    encryptedName: folder.encryptedName ?? folder.encrypted_name,
    nameIv: folder.nameIv ?? folder.name_iv,
    parentWrappedKey: folder.parentWrappedKey ?? folder.parent_wrapped_key ?? null,
    parentWrapIv: folder.parentWrapIv ?? folder.parent_wrap_iv ?? null,
    createdAt: folder.createdAt ?? folder.created_at,
    updatedAt: folder.updatedAt ?? folder.updated_at
  };
}

async function serveAsset(request, env, url, path) {
  const allowed = new Map([
    ["/", "/"],
    ["/cloud.css", "/cloud-runtime-20260810-37.css"],
    ["/cloud.js", "/cloud-runtime-20260810-112.js"],
    ["/crypto-vault.js", "/crypto-vault.js"],
    ["/file-safety.js", "/file-safety.js"],
    ["/media-range.js", "/media-range.js"],
    ["/media-client.js", "/media-client-20260810-8.js"],
    ["/media-worker.js", "/media-worker-20260810-9.js"],
    ["/manifest.webmanifest", "/manifest-20260810-3.webmanifest"],
    ["/manifest-v2.webmanifest", "/manifest-20260810-3.webmanifest"],
    ["/offline", "/offline"],
    ["/icons/icon-192.png", "/icons/icon-192.png"],
    ["/icons/icon-512.png", "/icons/icon-512.png"],
    ["/icons/icon-maskable-512.png", "/icons/icon-maskable-512.png"],
    ["/icons/apple-touch-icon.png", "/icons/apple-touch-icon.png"],
    ["/icons/icon-192-v2.png", "/icons/icon-192-v2.png"],
    ["/icons/icon-512-v2.png", "/icons/icon-512-v2.png"],
    ["/icons/icon-maskable-512-v2.png", "/icons/icon-maskable-512-v2.png"],
    ["/icons/apple-touch-icon-v2.png", "/icons/apple-touch-icon-v2.png"],
    ["/share.css", "/share-runtime-20260810-16.css"],
    ["/share.js", "/share-runtime-20260810-37.js"],
    ["/vendor/argon2.umd.min.js", "/vendor/argon2.umd.min.js"],
    ["/vendor/mpegts-1.8.0.js", "/vendor/mpegts-1.8.0.js"],
    ["/vendor/mpegts-1.8.0.LICENSE.txt", "/vendor/mpegts-1.8.0.LICENSE.txt"]
  ]);
  const assetPath = /^\/share\/[A-Za-z0-9_-]{43}\/?$/.test(path) ? "/share" : allowed.get(path);
  if (!assetPath) return new Response("Not found", { status: 404 });
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const isAuthenticationAsset = ["/cloud.js", "/crypto-vault.js", "/file-safety.js", "/media-range.js", "/media-client.js", "/media-worker.js", "/share.js"].includes(path);
  const isPwaMetadataAsset = path === "/manifest.webmanifest" || path === "/manifest-v2.webmanifest" || path.startsWith("/icons/");
  headers.set("Cache-Control", assetPath === "/" || assetPath === "/share" || isAuthenticationAsset || isPwaMetadataAsset
    ? "no-store"
    : "public, max-age=3600");
  if (path === "/media-worker.js") headers.set("Service-Worker-Allowed", "/cloud/");
  if (path === "/manifest.webmanifest" || path === "/manifest-v2.webmanifest") headers.set("Content-Type", "application/manifest+json; charset=utf-8");
  if (assetPath === "/offline") headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(response.body, { status: response.status, headers });
}

async function requireReadyFile(env, id, allowDeleted) {
  const file = await env.DB.prepare(`SELECT * FROM cloud_files WHERE id = ? AND status = 'ready' ${allowDeleted ? "" : "AND deleted_at IS NULL"}`).bind(id).first();
  if (!file) throw new HttpError(404, "ファイルが見つかりません。");
  return file;
}

async function requireUploadingFile(env, id) {
  const file = await env.DB.prepare("SELECT * FROM cloud_files WHERE id = ? AND status = 'uploading'").bind(id).first();
  if (!file) throw new HttpError(404, "アップロード情報が見つかりません。");
  return file;
}

async function requireFolder(env, id) {
  const folder = await env.DB.prepare(`SELECT id, parent_id, name, crypto_version AS cryptoVersion,
    encrypted_name AS encryptedName, name_iv AS nameIv, password_salt AS passwordSalt,
    password_wrapped_key AS passwordWrappedKey, password_wrap_iv AS passwordWrapIv,
    admin_wrapped_key AS adminWrappedKey, parent_wrapped_key AS parentWrappedKey,
    parent_wrap_iv AS parentWrapIv, password_hash FROM cloud_folders WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!folder) throw new HttpError(404, "フォルダが見つかりません。");
  return folder;
}

async function ensureValidFolderMove(env, folderId, parentId) {
  let current = parentId;
  let guard = 0;
  while (current && guard++ < 100) {
    if (Number(current) === Number(folderId)) throw new HttpError(400, "フォルダを自分自身または配下へ移動できません。");
    const folder = await env.DB.prepare("SELECT parent_id FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(current).first();
    if (!folder) throw new HttpError(404, "移動先フォルダが見つかりません。");
    current = folder.parent_id;
  }
  if (guard >= 100) throw new HttpError(400, "フォルダ階層を確認してください。");
}

async function requireFolderAccess(env, folderId, session) {
  if (session.role === "admin") return true;
  let current = folderId;
  let guard = 0;
  let protectedFolderUnlocked = false;
  const now = Math.floor(Date.now() / 1000);
  while (current && guard++ < 30) {
    const folder = await env.DB.prepare("SELECT id, parent_id, password_hash FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(current).first();
    if (!folder) throw new HttpError(404, "フォルダが見つかりません。");
    if (folder.password_hash) {
      protectedFolderUnlocked = true;
      const unlocked = await env.DB.prepare("SELECT 1 AS ok FROM cloud_folder_unlocks WHERE session_id = ? AND folder_id = ? AND expires_at > ?").bind(session.sessionId, folder.id, now).first();
      if (!unlocked) throw new HttpError(423, "フォルダのロックを解除してください。");
    }
    current = folder.parent_id;
  }
  return protectedFolderUnlocked;
}

async function unlockedMoveScopeId(env, folderId, session) {
  if (!folderId) throw new HttpError(403, "PWで解除したフォルダ内だけ移動できます。");
  await requireFolderAccess(env, folderId, session);
  let current = folderId;
  let outermostProtectedId = null;
  let guard = 0;
  while (current && guard++ < 30) {
    const folder = await env.DB.prepare("SELECT id, parent_id, password_hash FROM cloud_folders WHERE id = ? AND deleted_at IS NULL").bind(current).first();
    if (!folder) throw new HttpError(404, "フォルダが見つかりません。");
    if (folder.password_hash) outermostProtectedId = Number(folder.id);
    current = folder.parent_id;
  }
  if (!outermostProtectedId) throw new HttpError(403, "PWで解除したフォルダ内だけ移動できます。");
  return outermostProtectedId;
}

async function requireSameUnlockedMoveScope(env, sourceFolderId, destinationFolderId, session, movingFolder) {
  if (session.role === "admin") return true;
  if (!destinationFolderId) throw new HttpError(403, "副管理者はCloud Storageの最上位へ移動できません。");
  const sourceScope = await unlockedMoveScopeId(env, sourceFolderId, session);
  const destinationScope = await unlockedMoveScopeId(env, destinationFolderId, session);
  if (sourceScope !== destinationScope) throw new HttpError(403, "同じPW解除済みフォルダの配下だけ移動できます。");
  if (movingFolder && Number(sourceFolderId) === sourceScope) throw new HttpError(403, "PWで保護された最上位フォルダ自体は移動できません。");
  return true;
}

async function rememberFolderUnlock(env, session, folderId) {
  const expiresAt = Math.floor(Date.now() / 1000) + 2592000;
  await env.DB.prepare(`INSERT INTO cloud_folder_unlocks (session_id, folder_id, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id, folder_id) DO UPDATE SET expires_at = excluded.expires_at`).bind(session.sessionId, folderId, expiresAt).run();
}

async function breadcrumbs(env, folderId, session) {
  const result = [];
  let current = folderId;
  let guard = 0;
  while (current && guard++ < 20) {
    const folder = await env.DB.prepare(`SELECT id, parent_id, name, crypto_version AS cryptoVersion,
      encrypted_name AS encryptedName, name_iv AS nameIv, password_salt AS passwordSalt,
      password_wrapped_key AS passwordWrappedKey, password_wrap_iv AS passwordWrapIv,
      admin_wrapped_key AS adminWrappedKey, parent_wrapped_key AS parentWrappedKey,
      parent_wrap_iv AS parentWrapIv, password_hash IS NOT NULL AS isProtected,
      EXISTS(SELECT 1 FROM cloud_folder_unlocks unlock WHERE unlock.folder_id = cloud_folders.id AND unlock.session_id = ? AND unlock.expires_at > ?) AS isUnlocked
      FROM cloud_folders WHERE id = ? AND deleted_at IS NULL`)
      .bind(session.sessionId, Math.floor(Date.now() / 1000), current).first();
    if (!folder) break;
    result.unshift({
      id: folder.id,
      name: folder.name,
      cryptoVersion: folder.cryptoVersion,
      encryptedName: folder.encryptedName,
      nameIv: folder.nameIv,
      passwordSalt: folder.passwordSalt,
      passwordWrappedKey: folder.passwordWrappedKey,
      passwordWrapIv: folder.passwordWrapIv,
      adminWrappedKey: folder.adminWrappedKey,
      parentWrappedKey: folder.parentWrappedKey,
      parentWrapIv: folder.parentWrapIv,
      isProtected: Boolean(folder.isProtected),
      isUnlocked: session.role === "admin" ? true : Boolean(folder.isUnlocked),
      adminAccess: session.role === "admin"
    });
    current = folder.parent_id;
  }
  return result;
}

function mapFile(file) {
  return {
    id: file.id, folderId: file.folder_id, name: file.original_name, mimeType: file.mime_type,
    mediaKind: file.media_kind, sizeBytes: file.size_bytes,
    cryptoVersion: file.crypto_version, encryptedMetadata: file.encrypted_metadata,
    metadataIv: file.metadata_iv, wrappedFileKey: file.wrapped_file_key, fileKeyIv: file.file_key_iv,
    encryptedSizeBytes: file.encrypted_size_bytes, chunkSizeBytes: file.chunk_size_bytes,
    chunkCount: file.chunk_count,
    hasThumbnail: Boolean(file.thumbnail_key), createdAt: file.created_at, updatedAt: file.updated_at
  };
}

function objectResponse(object, disposition, filename, contentType, rangeRequested = false) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType || headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);
  if (rangeRequested && object.range) {
    const offset = Number(object.range.offset || 0);
    const length = Number(object.range.length || object.size);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

async function recordFailedLogin(env, fingerprint, attempt, now) {
  const inWindow = attempt && now - Number(attempt.first_failed_at) <= LOGIN_WINDOW_SECONDS;
  const failedCount = inWindow ? Number(attempt.failed_count) + 1 : 1;
  const firstFailedAt = inWindow ? Number(attempt.first_failed_at) : now;
  const lockedUntil = failedCount >= LOGIN_LIMIT ? now + LOGIN_WINDOW_SECONDS : null;
  await env.DB.prepare(`INSERT INTO cloud_login_attempts (fingerprint, failed_count, first_failed_at, locked_until)
    VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET failed_count = excluded.failed_count,
    first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`).bind(fingerprint, failedCount, firstFailedAt, lockedUntil).run();
}

async function requestFingerprint(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return sha256Base64Url(`${ip}:${env.LOGIN_FINGERPRINT_SECRET || env.SESSION_SECRET}`);
}

async function createSessionToken(session, maxAge, env) {
  const payload = { ...session, exp: Math.floor(Date.now() / 1000) + maxAge, version: String(env.SESSION_VERSION || "1") };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, env.SESSION_SECRET)}`;
}

async function readSession(request, env) {
  try {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token || !env.SESSION_SECRET) return null;
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature || !(await constantTimeText(signature, await sign(encoded, env.SESSION_SECRET)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    if (payload.exp <= Math.floor(Date.now() / 1000) || String(payload.version) !== String(env.SESSION_VERSION || "1")) return null;
    const account = ACCOUNTS.find((item) => item.role === payload.role);
    return account ? {
      role: account.role,
      label: account.label,
      canUpload: account.canUpload,
      canDelete: account.canDelete,
      canTrashUnlockedFiles: account.canTrashUnlockedFiles,
      canEditFiles: account.canEditFiles,
      canEditFolders: account.canEditFolders,
      canRenameUnlockedItems: account.canRenameUnlockedItems,
      canViewHistory: account.canViewHistory,
      canRequestDelete: account.canRequestDelete,
      canReviewDeletion: account.canReviewDeletion,
      sessionId: payload.sessionId
    } : null;
  } catch { return null; }
}

async function verifyPassword(password, encodedHash) {
  try {
    const [algorithm, iterationsText, saltText, hashText] = String(encodedHash || "").trim().split("$");
    if (algorithm !== "pbkdf2-sha256") return false;
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(saltText), iterations }, key, base64UrlToBytes(hashText).length * 8));
    return constantTimeBytes(actual, base64UrlToBytes(hashText));
  } catch { return false; }
}

async function hashPassword(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  return `pbkdf2-sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(bits)}`;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: SESSION_ALGORITHM, hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(SESSION_ALGORITHM, key, encoder.encode(value))));
}

async function sha256Base64Url(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function audit(env, eventType, session, targetType, targetId, details = null) {
  await env.DB.prepare("INSERT INTO cloud_audit_logs (event_type, actor_role, target_type, target_id, details_json) VALUES (?, ?, ?, ?, ?)")
    .bind(eventType, session?.role || null, targetType, targetId, details ? JSON.stringify(details) : null).run();
}

function detectKind(mime, name) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/") || /\.(mp4|m4v|flv|mkv|mov|avi|webm|mpg|mpeg|mxf|gxf|lxf|3gp|ts|m2ts|mts)$/i.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(m4a|mp3|wav|aac|flac|ogg)$/i.test(name)) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/i.test(name)) return "document";
  return "other";
}

function isBlockedFile(name, mime) {
  return /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|reg|apk|app|dmg|pkg)$/i.test(name)
    || ["application/x-msdownload", "application/x-sh", "application/x-executable"].includes(mime);
}

function validName(value) {
  const name = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 240 || name === "." || name === "..") throw new HttpError(400, "名前を確認してください。");
  return name;
}

function normalizeFolderPassword(value, required) {
  const password = String(value || "");
  if (!password && !required) return "";
  if (password.length < 4 || password.length > 128) throw new HttpError(400, "フォルダパスワードは4文字以上128文字以内で設定してください。");
  return password;
}

function normalizeEncryptedFolder(body, passwordRequired = true) {
  const encrypted = {
    encryptedName: validCryptoText(body.encryptedName, 2048, "フォルダ名"),
    nameIv: validCryptoText(body.nameIv, 64, "フォルダ名IV"),
    adminWrappedKey: validCryptoText(body.adminWrappedKey, 2048, "管理者用フォルダ鍵"),
    passwordSalt: null,
    passwordWrappedKey: null,
    passwordWrapIv: null,
    authProof: null
  };
  const hasPasswordPackage = Boolean(body.authProof || body.passwordSalt || body.passwordWrappedKey || body.passwordWrapIv);
  if (passwordRequired || hasPasswordPackage) {
    encrypted.passwordSalt = validCryptoText(body.passwordSalt, 128, "フォルダSalt");
    encrypted.passwordWrappedKey = validCryptoText(body.passwordWrappedKey, 512, "フォルダ鍵");
    encrypted.passwordWrapIv = validCryptoText(body.passwordWrapIv, 64, "フォルダ鍵IV");
    encrypted.authProof = validCryptoText(body.authProof, 256, "フォルダ認証");
  }
  return encrypted;
}

function normalizeParentWrappedFolder(body, required) {
  if (!required) return { parentWrappedKey: null, parentWrapIv: null };
  return {
    parentWrappedKey: validCryptoText(body.parentWrappedKey, 512, "親フォルダ用の鍵"),
    parentWrapIv: validCryptoText(body.parentWrapIv, 64, "親フォルダ用の鍵IV")
  };
}

function normalizeEncryptedFile(body, sizeBytes) {
  const chunkSizeBytes = Number(body.chunkSizeBytes);
  const chunkCount = Number(body.chunkCount);
  const encryptedSizeBytes = Number(body.encryptedSizeBytes);
  const expectedChunks = Math.ceil(sizeBytes / chunkSizeBytes);
  const validChunkSize = Number.isSafeInteger(chunkSizeBytes)
    && chunkSizeBytes >= MIN_MULTIPART_CHUNK_BYTES
    && chunkSizeBytes <= MAX_MULTIPART_CHUNK_BYTES
    && chunkSizeBytes % MIN_MULTIPART_CHUNK_BYTES === 0;
  if (!validChunkSize || chunkCount !== expectedChunks || chunkCount < 1 || chunkCount > MAX_MULTIPART_PARTS
    || encryptedSizeBytes !== sizeBytes + chunkCount * 32) {
    throw new HttpError(400, "暗号化ファイルの分割情報を確認してください。");
  }
  return {
    encryptedMetadata: validCryptoText(body.encryptedMetadata, 4096, "ファイル情報"),
    metadataIv: validCryptoText(body.metadataIv, 64, "ファイル情報IV"),
    wrappedFileKey: validCryptoText(body.wrappedFileKey, 512, "ファイル鍵"),
    fileKeyIv: validCryptoText(body.fileKeyIv, 64, "ファイル鍵IV"),
    encryptedSizeBytes,
    chunkSizeBytes,
    chunkCount
  };
}

function normalizeMime(value) {
  const mime = String(value || "application/octet-stream").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

function normalizeText(value, maxLength) { return String(value || "").trim().slice(0, maxLength); }
function normalizeShareToken(value) {
  const token = String(value || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "共有URLを確認してください。");
  return token;
}
function validCryptoText(value, maxLength, label) {
  const text = String(value || "");
  if (!text || text.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(text)) throw new HttpError(400, `${label}の暗号化情報を確認してください。`);
  return text;
}
function validateRsaPublicJwk(value) {
  if (!value || typeof value !== "object" || value.kty !== "RSA" || value.alg !== "RSA-OAEP-256" || value.ext !== true) {
    throw new HttpError(400, "公開鍵の形式を確認してください。");
  }
  const n = validCryptoText(value.n, 2048, "公開鍵");
  const e = validCryptoText(value.e, 32, "公開鍵");
  return { kty: "RSA", alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], n, e };
}
function optionalId(value) { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null; }
function publicSession(session, env) { return { role: session.role, accountName: session.label, loginId: String(env.LOGIN_ID || "").trim().toLowerCase(), sessionCacheId: session.sessionId, canUpload: session.canUpload, canDelete: session.canDelete, canTrashUnlockedFiles: session.canTrashUnlockedFiles, canEditFiles: session.canEditFiles, canEditFolders: session.canEditFolders, canRenameUnlockedItems: session.canRenameUnlockedItems, canViewHistory: session.canViewHistory, canRequestDelete: session.canRequestDelete, canReviewDeletion: session.canReviewDeletion }; }
function sessionMaxAge(env, role) {
  return role === "subadmin"
    ? clampNumber(env.SUBADMIN_SESSION_TTL_SECONDS, 2592000, 34560000, 34560000)
    : clampNumber(env.SESSION_TTL_SECONDS, 3600, 2592000, 2592000);
}
function requireAdmin(session) { if (session.role !== "admin") throw new HttpError(403, "この操作は管理者のみ行えます。"); }
function requireUpload(session) { if (!session.canUpload) throw new HttpError(403, "副管理者はアップロードできません。"); }
function requireUploadOwnership(session, file) { if (session.role !== "admin" && file.created_by !== session.role) throw new HttpError(403, "別アカウントの処理途中アップロードは操作できません。"); }
function requireDelete(session) { if (!session.canDelete) throw new HttpError(403, "副管理者は削除できません。"); }
function requireFileEdit(session) { if (!session.canEditFiles && !session.canRenameUnlockedItems) throw new HttpError(403, "既存ファイルの情報を変更できません。"); }
function requireFolderEdit(session) { if (!session.canEditFolders && !session.canRenameUnlockedItems) throw new HttpError(403, "フォルダ情報を変更できません。"); }
function requireHistory(session) { if (!session.canViewHistory) throw new HttpError(403, "アップロード履歴は管理者のみ確認できます。"); }
function requireDeletionRequest(session) { if (!session.canRequestDelete) throw new HttpError(403, "削除申請は副管理者のみ行えます。"); }
function requireDeletionReview(session) { if (!session.canReviewDeletion) throw new HttpError(403, "削除申請の確認は管理者のみ行えます。"); }
function requireTrashVisibility(session, file) { if (file.deleted_at && !session.canDelete) throw new HttpError(404, "ファイルが見つかりません。"); }
function sameOrigin(request, url) { return !request.headers.get("Origin") || request.headers.get("Origin") === url.origin; }
function validMutationRequest(request, url) { return sameOrigin(request, url) && (request.headers.get("Content-Type") || "").toLowerCase() !== "application/x-www-form-urlencoded"; }
function sessionCookie(token, maxAge, secure) { return `${SESSION_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function clearCookie(secure) { return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function shareSessionCookie(token, maxAge, secure) { return `${SHARE_SESSION_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function readCookie(request, name) { const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return match ? match[1] : ""; }
function bytesToBase64Url(bytes) { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(text) { const base64 = String(text).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(text).length / 4) * 4, "="); return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); }
function constantTimeBytes(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
async function constantTimeText(a, b) { return constantTimeBytes(encoder.encode(a), encoder.encode(b)); }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }

async function readJson(request, maxBytes) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。");
  try { return await request.json(); } catch { throw new HttpError(400, "送信内容を確認してください。"); }
}

function json(value, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: https://*.cloudflarestream.com https://*.videodelivery.net; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.cloudflarestream.com https://*.videodelivery.net; frame-src https://*.cloudflarestream.com https://*.videodelivery.net; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

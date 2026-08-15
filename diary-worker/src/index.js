const BASE_PATH = "/diary";
const SESSION_COOKIE = "troom_diary_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAIN_ADMIN_ACCOUNT_ID = "main-admin";
const WIFE_ADMIN_ACCOUNT_ID = "wife-admin";
const CHIHARU_ADMIN_ACCOUNT_ID = "chiharu-admin";
const TANAKA_HOUSEHOLD_ID = "tanaka-household";
const CHIHARU_HOUSEHOLD_ID = "chiharu-household";
const DIARY_ACCOUNTS = [
  { id: MAIN_ADMIN_ACCOUNT_ID, name: "田中宏知", householdId: TANAKA_HOUSEHOLD_ID, role: "admin", isGlobalOwner: true, canViewTrash: true, canPermanentlyDelete: true, canViewInvestment: true, loginIdSecretKey: "DIARY_MAIN_ADMIN_LOGIN_ID", secretKey: "DIARY_MAIN_ADMIN_PASSWORD_HASH", sessionVersion: 1 },
  { id: WIFE_ADMIN_ACCOUNT_ID, name: "田中暢美", householdId: TANAKA_HOUSEHOLD_ID, role: "admin", isGlobalOwner: false, canViewTrash: true, canPermanentlyDelete: true, canViewInvestment: true, loginIdSecretKey: "DIARY_WIFE_ADMIN_LOGIN_ID", secretKey: "DIARY_WIFE_ADMIN_PASSWORD_HASH", sessionVersion: 1 }
];

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === `${BASE_PATH}.html`) {
        return secureResponse(Response.redirect(`${url.origin}${BASE_PATH}/`, 308));
      }
      const path = url.pathname.startsWith(BASE_PATH)
        ? url.pathname.slice(BASE_PATH.length) || "/"
        : url.pathname;

      if (url.pathname === BASE_PATH) {
        return secureResponse(Response.redirect(`${url.origin}${BASE_PATH}/`, 308));
      }

      if (path.startsWith("/api/")) {
        const response = await handleApi(request, env, url, path);
        return secureResponse(await withRollingSession(request, response, env, url, path));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return secureResponse(json({ error: "Method not allowed" }, 405));
      }

      if (isInvestmentAssetPath(path)) {
        const session = await readSession(request, env);
        if (!session || !session.canViewInvestment) {
          const isPageRequest = path === "/investment" || path === "/investment/";
          return secureResponse(isPageRequest
            ? Response.redirect(`${url.origin}${BASE_PATH}/`, 302)
            : new Response("Not found", { status: 404 }));
        }
      }

      return secureResponse(await serveAsset(request, env, url, path));
    } catch (error) {
      if (error instanceof HttpError) {
        return secureResponse(json({ error: error.message }, error.status));
      }
      console.error("Diary request failed", error instanceof Error ? error.message : "unknown error");
      return secureResponse(json({ error: "日記を読み込めませんでした。時間を置いてもう一度お試しください。" }, 500));
    }
  }
};

async function handleApi(request, env, url, path) {
  if (path === "/api/session" && request.method === "GET") {
    const session = await readSession(request, env);
    return json({
      authenticated: Boolean(session),
      role: session?.role || null,
      accountName: session?.accountName || null,
      loginId: session?.loginId || null,
      householdId: session?.householdId || null,
      activeHouseholdId: session?.activeHouseholdId || null,
      isGlobalOwner: Boolean(session?.isGlobalOwner),
      mustChangePassword: Boolean(session?.mustChangePassword),
      canViewTrash: Boolean(session?.canViewTrash),
      canPermanentlyDelete: Boolean(session?.canPermanentlyDelete),
      canViewInvestment: Boolean(session?.canViewInvestment)
    });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "不正なリクエストです。" }, 403);
    if (!DIARY_ACCOUNTS.every((account) => env[account.secretKey] && env[account.loginIdSecretKey]) || !env.SESSION_SECRET) {
      return json({ error: "日記の認証設定が完了していません。" }, 503);
    }

    const body = await readJson(request, 4096);
    const loginId = normalizeLoginId(body.loginId);
    const password = typeof body.password === "string" ? body.password : "";
    if (!loginId || !password || password.length > 256) {
      return json({ error: "IDまたはパスワードを確認してください。" }, 400);
    }

    const requestedAccount = await findAccountByLoginId(loginId, env);
    const now = Math.floor(Date.now() / 1000);
    const fingerprint = requestedAccount ? await loginFingerprint(request, requestedAccount, env) : "";
    if (fingerprint) {
      const attempt = await env.DB.prepare("SELECT failed_count, first_failed_at, locked_until FROM diary_login_attempts WHERE fingerprint = ?").bind(fingerprint).first();
      if (Number(attempt?.locked_until || 0) > now) {
        return json({ error: "ログインが一時停止されています。15分ほど待ってからお試しください。" }, 429);
      }
    }
    const passwordHash = requestedAccount
      ? (requestedAccount.passwordHash || (requestedAccount.temporarySecretKey ? env[requestedAccount.temporarySecretKey] : env[requestedAccount.secretKey]))
      : null;
    const account = requestedAccount && passwordHash && await verifyPassword(password, passwordHash, env)
      ? requestedAccount
      : null;
    if (!account) {
      if (requestedAccount && fingerprint) await recordFailedLogin(env, fingerprint, now);
      return json({ error: "IDまたはパスワードが違います。" }, 401);
    }
    await env.DB.prepare("DELETE FROM diary_login_attempts WHERE fingerprint = ?").bind(fingerprint).run();

    const maxAge = getSessionMaxAge(env);
    const token = await createSessionToken(account, maxAge, env);
    const headers = new Headers();
    headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
    return json({
      authenticated: true,
      role: account.role,
      accountName: account.name,
      loginId: accountLoginId(account, env),
      householdId: account.householdId,
      activeHouseholdId: account.householdId,
      isGlobalOwner: Boolean(account.isGlobalOwner),
      mustChangePassword: Boolean(account.mustChangePassword),
      canViewTrash: account.canViewTrash,
      canPermanentlyDelete: account.canPermanentlyDelete,
      canViewInvestment: account.canViewInvestment
    }, 200, headers);
  }

  if (path === "/api/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "不正なリクエストです。" }, 403);
    const headers = new Headers();
    headers.set("Set-Cookie", clearSessionCookie(url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const session = await readSession(request, env);
  if (!session) return json({ error: "ログインが必要です。" }, 401);

  if (path === "/api/password/initial" && request.method === "POST") {
    if (!validMutationRequest(request, url)) return json({ error: "不正なリクエストです。" }, 403);
    return changeInitialPassword(request, env, session, url);
  }

  if (session.mustChangePassword) {
    return json({ error: "最初にパスワードを再設定してください。", mustChangePassword: true }, 428);
  }

  if (path === "/api/households" && request.method === "GET") {
    const households = session.isGlobalOwner
      ? [
          { id: "tanaka-household", name: "田中宏知・田中暢美" },
          { id: "chiharu-household", name: "田中千晴" }
        ]
      : [{ id: session.householdId, name: session.accountName }];
    return json({ households, activeHouseholdId: session.activeHouseholdId });
  }

  if (path === "/api/households/select" && request.method === "POST") {
    if (!session.isGlobalOwner) return json({ error: "この操作を行う権限がありません。" }, 403);
    const body = await readJson(request, 4096);
    const householdId = String(body.householdId || "");
    if (!["tanaka-household", "chiharu-household"].includes(householdId)) {
      return json({ error: "日記の管理対象を確認できませんでした。" }, 400);
    }
    const account = await findAccountById(session.accountId, env);
    const maxAge = getSessionMaxAge(env);
    const token = await createSessionToken(account, maxAge, env, householdId);
    const headers = new Headers();
    headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
    return json({ ok: true, activeHouseholdId: householdId }, 200, headers);
  }

  if (request.method !== "GET" && !validMutationRequest(request, url)) {
    return json({ error: "不正なリクエストです。" }, 403);
  }

  if (path === "/api/entries" && request.method === "GET") {
    return listEntries(url, env, session);
  }

  if (path === "/api/entries" && request.method === "POST") {
    requireAdmin(session);
    return createEntry(request, env, session);
  }

  if (path === "/api/meta" && request.method === "GET") {
    return listMeta(env, session);
  }

  if (path === "/api/investment-history" && request.method === "GET") {
    if (!session.canViewInvestment) return json({ error: "Not found" }, 404);
    return listInvestmentHistory(env);
  }

  if (path === "/api/photos" && request.method === "GET") {
    return listPhotos(url, env, session);
  }

  if (path === "/api/photos/meta" && request.method === "GET") {
    return listPhotoMeta(env, session);
  }

  const photoAssetMatch = path.match(/^\/api\/photos\/([0-9a-f-]{36})\/(thumbnail|display|original)$/i);
  if (photoAssetMatch && request.method === "GET") {
    return servePhoto(photoAssetMatch[1], photoAssetMatch[2], request, env, session, url);
  }

  const photoDeleteMatch = path.match(/^\/api\/photos\/([0-9a-f-]{36})$/i);
  if (photoDeleteMatch && request.method === "DELETE") {
    requireAdmin(session);
    return deleteEntryPhoto(photoDeleteMatch[1], env, session);
  }

  const entryPhotoMatch = path.match(/^\/api\/entries\/(\d+)\/photos$/);
  if (entryPhotoMatch && request.method === "POST") {
    requireAdmin(session);
    return uploadEntryPhoto(Number(entryPhotoMatch[1]), request, env, session);
  }

  const entryMatch = path.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch && request.method === "GET") {
    return getEntry(Number(entryMatch[1]), env, session);
  }
  if (entryMatch && request.method === "PUT") {
    requireAdmin(session);
    return updateEntry(Number(entryMatch[1]), request, env, session);
  }
  if (entryMatch && request.method === "DELETE") {
    requireAdmin(session);
    return moveEntryToTrash(Number(entryMatch[1]), request, env, session);
  }

  const restoreMatch = path.match(/^\/api\/entries\/(\d+)\/restore$/);
  if (restoreMatch && request.method === "POST") {
    requireTrashAccess(session);
    return restoreEntry(Number(restoreMatch[1]), env, session);
  }

  const permanentDeleteMatch = path.match(/^\/api\/entries\/(\d+)\/permanent$/);
  if (permanentDeleteMatch && request.method === "DELETE") {
    requirePermanentDeleteAccess(session);
    return permanentlyDeleteEntry(Number(permanentDeleteMatch[1]), request, env, session);
  }

  return json({ error: "Not found" }, 404);
}

async function serveAsset(request, env, url, path) {
  if (!env.ASSETS) return new Response("Diary assets are not configured", { status: 503 });

  const assetPaths = new Map([
    ["/diary.css", "/diary.css"],
    ["/diary.js", "/diary.js"],
    ["/troom-date-picker.css", "/troom-date-picker.css"],
    ["/troom-date-picker.js", "/troom-date-picker.js"],
    ["/manifest.webmanifest", "/manifest.webmanifest"],
    ["/service-worker.js", "/service-worker.js"],
    ["/icons/diary-icon-source.png", "/icons/diary-icon-source.png"],
    ["/icons/diary-icon-source-v2.png", "/icons/diary-icon-source-v2.png"],
    ["/icons/diary-icon-source-v3.png", "/icons/diary-icon-source-v3.png"],
    ["/icons/diary-icon-source-v4.png", "/icons/diary-icon-source-v4.png"],
    ["/icons/icon-192.png", "/icons/icon-192.png"],
    ["/icons/icon-192-v2.png", "/icons/icon-192-v2.png"],
    ["/icons/icon-192-v3.png", "/icons/icon-192-v3.png"],
    ["/icons/icon-192-v4.png", "/icons/icon-192-v4.png"],
    ["/icons/icon-512.png", "/icons/icon-512.png"],
    ["/icons/icon-512-v2.png", "/icons/icon-512-v2.png"],
    ["/icons/icon-512-v3.png", "/icons/icon-512-v3.png"],
    ["/icons/icon-512-v4.png", "/icons/icon-512-v4.png"],
    ["/icons/icon-maskable-512.png", "/icons/icon-maskable-512.png"],
    ["/icons/icon-maskable-512-v2.png", "/icons/icon-maskable-512-v2.png"],
    ["/icons/icon-maskable-512-v3.png", "/icons/icon-maskable-512-v3.png"],
    ["/icons/icon-maskable-512-v4.png", "/icons/icon-maskable-512-v4.png"],
    ["/icons/apple-touch-icon.png", "/icons/apple-touch-icon.png"],
    ["/icons/apple-touch-icon-v2.png", "/icons/apple-touch-icon-v2.png"],
    ["/icons/apple-touch-icon-v3.png", "/icons/apple-touch-icon-v3.png"],
    ["/icons/favicon-64.png", "/icons/favicon-64.png"],
    ["/icons/favicon-64-v2.png", "/icons/favicon-64-v2.png"],
    ["/icons/favicon-64-v3.png", "/icons/favicon-64-v3.png"],
    ["/icons/favicon-64-v4.png", "/icons/favicon-64-v4.png"],
    ["/investment.css", "/investment.css"],
    ["/investment.js", "/investment.js"]
  ]);
  const isDiaryRoute = path === "/" || path === "/tags" || path === "/tags/" || path.startsWith("/entry/") || path.startsWith("/tag/") || path === "/trash";
  const isInvestmentRoute = path === "/investment" || path === "/investment/";
  const assetPath = assetPaths.get(path) || (isDiaryRoute ? "/" : (isInvestmentRoute ? "/investment.html" : null));
  if (!assetPath) return new Response("Not found", { status: 404 });

  const assetUrl = new URL(assetPath, url.origin);
  const assetRequest = new Request(assetUrl, request);
  let response = await env.ASSETS.fetch(assetRequest);
  if (isInvestmentRoute && response.status >= 300 && response.status < 400 && response.headers.get("Location")) {
    const redirectedAssetUrl = new URL(response.headers.get("Location"), url.origin);
    response = await env.ASSETS.fetch(new Request(redirectedAssetUrl, request));
  }
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", assetPath === "/"
    ? "no-store"
    : (assetPath === "/service-worker.js" ? "no-cache" : "public, max-age=3600"));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isInvestmentAssetPath(path) {
  return path === "/investment"
    || path === "/investment/"
    || path === "/investment.css"
    || path === "/investment.js";
}

async function listInvestmentHistory(env) {
  const result = await env.DB.prepare(`
    SELECT
      recorded_at,
      total,
      cash,
      stocks,
      funds,
      bonds,
      crypto,
      futures,
      points,
      other
    FROM investment_history
    ORDER BY recorded_at ASC
  `).all();

  const records = (result.results || []).map((row) => ({
    date: row.recorded_at,
    total: Number(row.total),
    cash: Number(row.cash),
    stocks: Number(row.stocks),
    funds: Number(row.funds),
    bonds: Number(row.bonds),
    crypto: Number(row.crypto),
    futures: Number(row.futures),
    points: Number(row.points),
    other: Number(row.other)
  }));

  return json({
    asOf: records.at(-1)?.date || null,
    records
  });
}

async function listEntries(url, env, session) {
  const limit = clampNumber(url.searchParams.get("limit"), 1, 50, 20);
  const offset = clampNumber(url.searchParams.get("offset"), 0, 1000000, 0);
  const query = normalizeSearch(url.searchParams.get("q") || "", 100);
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "")
    ? url.searchParams.get("month")
    : "";
  const dateFrom = normalizeFilterDate(url.searchParams.get("dateFrom"));
  const dateTo = normalizeFilterDate(url.searchParams.get("dateTo"));
  const dateRange = validateDateRange(dateFrom, dateTo);
  const tag = normalizeTag(url.searchParams.get("tag") || "");
  const trashRequested = url.searchParams.get("trash") === "1";
  const trashAccess = trashScopeAccess(session, "ts");
  if (trashRequested && (!session.canViewTrash || !trashAccess)) {
    throw new HttpError(403, "ゴミ箱を閲覧する権限がありません。");
  }
  const trash = trashRequested;

  const conditions = ["e.household_id = ?", trash ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
  const bindings = [session.activeHouseholdId];
  if (trash) {
    conditions.push(`EXISTS (
      SELECT 1 FROM diary_trash_scopes ts
      WHERE ts.entry_id = e.id AND ${trashAccess.clause}
    )`);
    bindings.push(...trashAccess.bindings);
  }
  if (query) {
    conditions.push("(instr(e.title, ?) > 0 OR instr(e.content, ?) > 0)");
    bindings.push(query, query);
  }
  if (month) {
    conditions.push("substr(e.entry_date, 1, 7) = ?");
    bindings.push(month);
  }
  if (dateRange.from === dateRange.to && dateRange.from) {
    conditions.push("e.entry_date = ?");
    bindings.push(dateRange.from);
  } else {
    if (dateRange.from) {
      conditions.push("e.entry_date >= ?");
      bindings.push(dateRange.from);
    }
    if (dateRange.to) {
      conditions.push("e.entry_date <= ?");
      bindings.push(dateRange.to);
    }
  }
  if (tag) {
    conditions.push("EXISTS (SELECT 1 FROM diary_tags filter_tag WHERE filter_tag.entry_id = e.id AND filter_tag.tag = ?)");
    bindings.push(tag);
  }

  const statement = `
    SELECT
      e.id, e.entry_date, e.title, e.content, e.content_format, e.author_id, e.author_name, e.created_at, e.updated_at,
      e.deleted_at, e.deleted_by_id, e.deleted_by_name, e.revision,
      COALESCE((SELECT json_group_array(tag) FROM diary_tags dt WHERE dt.entry_id = e.id), '[]') AS tags
    FROM diary_entries e
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.entry_date DESC, e.id DESC
    LIMIT ? OFFSET ?
  `;
  bindings.push(limit + 1, offset);
  const result = await env.DB.prepare(statement).bind(...bindings).all();
  const rows = (result.results || []).map(serializeEntry);
  const hasMore = rows.length > limit;
  return json({ entries: rows.slice(0, limit), hasMore, offset, limit });
}

async function getEntry(id, env, session) {
  const row = await env.DB.prepare(`
    SELECT
      e.id, e.entry_date, e.title, e.content, e.content_format, e.author_id, e.author_name, e.created_at, e.updated_at,
      e.deleted_at, e.deleted_by_id, e.deleted_by_name, e.revision,
      COALESCE((SELECT json_group_array(tag) FROM diary_tags dt WHERE dt.entry_id = e.id), '[]') AS tags
    FROM diary_entries e
    WHERE e.id = ? AND e.household_id = ?
  `).bind(id, session.activeHouseholdId).first();
  if (!row || (row.deleted_at && !(await canAccessTrashEntry(id, env, session)))) {
    return json({ error: "日記が見つかりません。" }, 404);
  }
  const photos = await listEntryPhotos(id, env, session);
  return json({ entry: { ...serializeEntry(row), photos } });
}

async function listEntryPhotos(entryId, env, session) {
  const result = await env.DB.prepare(`
    SELECT p.id, p.entry_id, p.file_name, p.content_type, p.original_size, p.width, p.height,
           p.created_by_name, p.created_at, e.entry_date, e.title AS entry_title,
           e.author_id, e.author_name
    FROM diary_photos p
    JOIN diary_entries e ON e.id = p.entry_id
    WHERE p.entry_id = ? AND e.household_id = ?
    ORDER BY p.created_at ASC, p.id ASC
  `).bind(entryId, session.activeHouseholdId).all();
  return (result.results || []).map(serializePhoto);
}

async function listPhotos(url, env, session) {
  const limit = clampNumber(url.searchParams.get("limit"), 1, 100, 48);
  const offset = clampNumber(url.searchParams.get("offset"), 0, 1000000, 0);
  const query = normalizeSearch(url.searchParams.get("q") || "", 100);
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "")
    ? url.searchParams.get("month")
    : "";
  const author = normalizeSearch(url.searchParams.get("author") || "", 100);
  const conditions = ["e.household_id = ?", "e.deleted_at IS NULL"];
  const bindings = [session.activeHouseholdId];
  if (query) {
    conditions.push("(instr(p.file_name, ?) > 0 OR instr(e.title, ?) > 0 OR instr(e.content, ?) > 0)");
    bindings.push(query, query, query);
  }
  if (month) {
    conditions.push("substr(e.entry_date, 1, 7) = ?");
    bindings.push(month);
  }
  if (author) {
    conditions.push("e.author_id = ?");
    bindings.push(author);
  }
  bindings.push(limit + 1, offset);
  const result = await env.DB.prepare(`
    SELECT p.id, p.entry_id, p.file_name, p.content_type, p.original_size, p.width, p.height,
           p.created_by_name, p.created_at, e.entry_date, e.title AS entry_title,
           e.author_id, e.author_name
    FROM diary_photos p
    JOIN diary_entries e ON e.id = p.entry_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.entry_date DESC, p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings).all();
  const rows = result.results || [];
  return json({
    photos: rows.slice(0, limit).map(serializePhoto),
    hasMore: rows.length > limit,
    offset,
    limit
  });
}

async function listPhotoMeta(env, session) {
  const [months, authors] = await Promise.all([
    env.DB.prepare(`
      SELECT substr(e.entry_date, 1, 7) AS value, COUNT(*) AS count
      FROM diary_photos p
      JOIN diary_entries e ON e.id = p.entry_id
      WHERE e.household_id = ? AND e.deleted_at IS NULL
      GROUP BY value
      ORDER BY value DESC
    `).bind(session.activeHouseholdId).all(),
    env.DB.prepare(`
      SELECT e.author_id AS value, e.author_name AS label, COUNT(*) AS count
      FROM diary_photos p
      JOIN diary_entries e ON e.id = p.entry_id
      WHERE e.household_id = ? AND e.deleted_at IS NULL
      GROUP BY e.author_id, e.author_name
      ORDER BY e.author_name ASC
    `).bind(session.activeHouseholdId).all()
  ]);
  return json({ months: months.results || [], authors: authors.results || [] });
}

async function uploadEntryPhoto(entryId, request, env, session) {
  if (!env.MEDIA) throw new HttpError(503, "画像の保存先が設定されていません。");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 80 * 1024 * 1024) throw new HttpError(413, "画像の容量が大きすぎます。");
  const entry = await env.DB.prepare("SELECT id FROM diary_entries WHERE id = ? AND household_id = ? AND deleted_at IS NULL")
    .bind(entryId, session.activeHouseholdId).first();
  if (!entry) throw new HttpError(404, "画像を追加する日記が見つかりません。");

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "画像を読み取れませんでした。");
  }
  const id = String(form.get("id") || "").toLowerCase();
  const original = form.get("original");
  const display = form.get("display");
  const thumbnail = form.get("thumbnail");
  if (!isUuid(id)) throw new HttpError(400, "画像IDを確認できませんでした。");
  if (!(original instanceof File) || !(display instanceof File) || !(thumbnail instanceof File)) {
    throw new HttpError(400, "画像データが不足しています。");
  }
  if (!String(original.type).startsWith("image/") || !String(display.type).startsWith("image/") || !String(thumbnail.type).startsWith("image/")) {
    throw new HttpError(400, "画像ファイルのみ追加できます。");
  }
  if (!original.size || original.size > 60 * 1024 * 1024 || display.size > 3 * 1024 * 1024 || thumbnail.size > 700 * 1024) {
    throw new HttpError(413, "画像の容量を確認してください。");
  }
  const existing = await env.DB.prepare("SELECT id FROM diary_photos WHERE id = ?").bind(id).first();
  if (existing) throw new HttpError(409, "同じ画像が既に保存されています。");

  const safeName = normalizeFileName(original.name || "photo");
  const width = clampNumber(form.get("width"), 1, 100000, null);
  const height = clampNumber(form.get("height"), 1, 100000, null);
  const baseKey = `diary/${session.activeHouseholdId}/${entryId}/${id}`;
  const originalKey = `${baseKey}/original`;
  const displayKey = `${baseKey}/display`;
  const thumbnailKey = `${baseKey}/thumbnail`;
  const keys = [originalKey, displayKey, thumbnailKey];
  try {
    await Promise.all([
      env.MEDIA.put(originalKey, original.stream(), { httpMetadata: { contentType: original.type || "application/octet-stream" } }),
      env.MEDIA.put(displayKey, display.stream(), { httpMetadata: { contentType: display.type || "image/webp" } }),
      env.MEDIA.put(thumbnailKey, thumbnail.stream(), { httpMetadata: { contentType: thumbnail.type || "image/webp" } })
    ]);
    await env.DB.prepare(`
      INSERT INTO diary_photos (
        id, entry_id, file_name, content_type, original_size,
        original_key, display_key, thumbnail_key, width, height,
        created_by_id, created_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, entryId, safeName, original.type || "application/octet-stream", original.size,
      originalKey, displayKey, thumbnailKey, width, height,
      session.accountId, session.accountName
    ).run();
  } catch (error) {
    await Promise.allSettled(keys.map((key) => env.MEDIA.delete(key)));
    console.error("Diary photo upload failed", error instanceof Error ? error.message : "unknown error");
    throw new HttpError(500, "画像を保存できませんでした。");
  }
  const row = await env.DB.prepare(`
    SELECT id, entry_id, file_name, content_type, original_size, width, height,
           created_by_name, created_at
    FROM diary_photos WHERE id = ?
  `).bind(id).first();
  return json({ photo: serializePhoto(row) });
}

async function servePhoto(id, variant, request, env, session, url) {
  if (!env.MEDIA) return new Response("Media storage unavailable", { status: 503 });
  const row = await env.DB.prepare(`
    SELECT p.file_name, p.content_type, p.original_key, p.display_key, p.thumbnail_key, e.deleted_at
    FROM diary_photos p
    JOIN diary_entries e ON e.id = p.entry_id
    WHERE p.id = ? AND e.household_id = ?
  `).bind(id.toLowerCase(), session.activeHouseholdId).first();
  if (!row || (row.deleted_at && !(await canAccessTrashEntryByPhoto(id.toLowerCase(), env, session)))) {
    return new Response("Not found", { status: 404 });
  }
  const key = variant === "original" ? row.original_key : (variant === "display" ? row.display_key : row.thumbnail_key);
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("Content-Type", headers.get("Content-Type") || (variant === "original" ? row.content_type : "image/webp"));
  if (url.searchParams.get("download") === "1") {
    const name = variant === "original" ? row.file_name : `${stripExtension(row.file_name)}-low.webp`;
    headers.set("Content-Disposition", contentDisposition(name));
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

async function deleteEntryPhoto(id, env, session) {
  if (!env.MEDIA) throw new HttpError(503, "画像の保存先を確認できないため、削除を中止しました。");
  const normalizedId = id.toLowerCase();
  const row = await env.DB.prepare(`
    SELECT p.original_key, p.display_key, p.thumbnail_key
    FROM diary_photos p
    JOIN diary_entries e ON e.id = p.entry_id
    WHERE p.id = ? AND e.household_id = ? AND e.deleted_at IS NULL
  `).bind(normalizedId, session.activeHouseholdId).first();
  if (!row) throw new HttpError(404, "削除する画像が見つかりません。");

  await env.MEDIA.delete([row.original_key, row.display_key, row.thumbnail_key]);
  const result = await env.DB.prepare(`
    DELETE FROM diary_photos
    WHERE id = ? AND EXISTS (
      SELECT 1 FROM diary_entries e
      WHERE e.id = diary_photos.entry_id AND e.household_id = ? AND e.deleted_at IS NULL
    )
  `).bind(normalizedId, session.activeHouseholdId).run();
  if (!result.meta?.changes) throw new HttpError(409, "画像を削除できませんでした。日記を読み込み直してください。");
  return json({ ok: true });
}

async function listMeta(env, session) {
  const [months, tags] = await Promise.all([
    env.DB.prepare(`
      SELECT substr(entry_date, 1, 7) AS value, COUNT(*) AS count
      FROM diary_entries
      WHERE household_id = ? AND deleted_at IS NULL
      GROUP BY value
      ORDER BY value DESC
    `).bind(session.activeHouseholdId).all(),
    env.DB.prepare(`
      SELECT dt.tag AS value, COUNT(*) AS count
      FROM diary_tags dt
      JOIN diary_entries e ON e.id = dt.entry_id
      WHERE e.household_id = ? AND e.deleted_at IS NULL
      GROUP BY dt.tag
      ORDER BY count DESC, dt.tag ASC
    `).bind(session.activeHouseholdId).all()
  ]);
  return json({ months: months.results || [], tags: tags.results || [] });
}

async function createEntry(request, env, session) {
  const input = validateEntryInput(await readJson(request, 1500000));
  const result = await env.DB.prepare(`
    INSERT INTO diary_entries (entry_date, title, content, content_format, author_id, author_name, household_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(input.entryDate, input.title, input.content, input.contentFormat, session.accountId, session.accountName, session.activeHouseholdId).run();
  const id = Number(result.meta?.last_row_id);
  await replaceTags(env, id, input.tags);
  return getEntry(id, env, session);
}

async function updateEntry(id, request, env, session) {
  const body = await readJson(request, 1500000);
  const input = validateEntryInput(body);
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return json({ error: "編集情報が不足しています。再読み込みしてください。" }, 400);
  }

  const result = await env.DB.prepare(`
    UPDATE diary_entries
    SET entry_date = ?, title = ?, content = ?, content_format = ?, updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(input.entryDate, input.title, input.content, input.contentFormat, id, session.activeHouseholdId, revision).run();

  if (!result.meta?.changes) {
    return json({ error: "別の端末で更新された可能性があります。再読み込みしてください。" }, 409);
  }
  await replaceTags(env, id, input.tags);
  return getEntry(id, env, session);
}

async function moveEntryToTrash(id, request, env, session) {
  const body = await readJson(request, 4096);
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return json({ error: "削除情報を確認できませんでした。再読み込みしてください。" }, 400);
  }
  const entry = await env.DB.prepare(`
    SELECT id, author_id, household_id
    FROM diary_entries
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(id, session.activeHouseholdId, revision).first();
  if (!entry) return json({ error: "削除できませんでした。再読み込みしてください。" }, 409);

  const nextRevision = revision + 1;
  const scopes = trashScopesForDeletion(entry, session);
  const statements = [env.DB.prepare(`
    UPDATE diary_entries
    SET deleted_at = CURRENT_TIMESTAMP, deleted_by_id = ?, deleted_by_name = ?,
        updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(session.accountId, session.accountName, id, session.activeHouseholdId, revision)];
  for (const scope of scopes) {
    statements.push(env.DB.prepare(`
      INSERT INTO diary_trash_scopes (
        entry_id, owner_account_id, household_id, scope_type,
        entry_revision, deleted_by_id, deleted_at
      )
      SELECT id, ?, household_id, ?, revision, deleted_by_id, deleted_at
      FROM diary_entries
      WHERE id = ? AND household_id = ? AND revision = ?
        AND deleted_at IS NOT NULL AND deleted_by_id = ?
      ON CONFLICT(entry_id, owner_account_id, scope_type) DO UPDATE SET
        household_id = excluded.household_id,
        entry_revision = excluded.entry_revision,
        deleted_by_id = excluded.deleted_by_id,
        deleted_at = excluded.deleted_at
    `).bind(
      scope.ownerAccountId,
      scope.scopeType,
      id,
      session.activeHouseholdId,
      nextRevision,
      session.accountId
    ));
  }
  const results = await env.DB.batch(statements);
  return results[0]?.meta?.changes
    ? json({ ok: true })
    : json({ error: "削除できませんでした。再読み込みしてください。" }, 409);
}

async function restoreEntry(id, env, session) {
  const access = trashScopeAccess(session, "ts");
  if (!access) throw new HttpError(403, "ゴミ箱を操作する権限がありません。");
  const entry = await env.DB.prepare(`
    SELECT e.id, e.revision
    FROM diary_entries e
    WHERE e.id = ? AND e.household_id = ? AND e.deleted_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM diary_trash_scopes ts
        WHERE ts.entry_id = e.id AND ${access.clause}
      )
  `).bind(id, session.activeHouseholdId, ...access.bindings).first();
  if (!entry) return json({ error: "復元する日記が見つかりません。" }, 404);
  const nextRevision = Number(entry.revision) + 1;
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE diary_entries
    SET deleted_at = NULL, deleted_by_id = NULL, deleted_by_name = NULL,
        updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NOT NULL
  `).bind(id, session.activeHouseholdId, entry.revision), env.DB.prepare(`
    DELETE FROM diary_trash_scopes
    WHERE entry_id = ? AND EXISTS (
      SELECT 1 FROM diary_entries e
      WHERE e.id = diary_trash_scopes.entry_id
        AND e.household_id = ? AND e.deleted_at IS NULL AND e.revision = ?
    )
  `).bind(id, session.activeHouseholdId, nextRevision)]);
  return results[0]?.meta?.changes
    ? getEntry(id, env, session)
    : json({ error: "復元する日記が見つかりません。" }, 404);
}

async function permanentlyDeleteEntry(id, request, env, session) {
  const body = await readJson(request, 4096);
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return json({ error: "削除情報を確認できませんでした。再読み込みしてください。" }, 400);
  }
  if (env.MEDIA) await drainMediaDeletionQueue(env);

  const access = trashScopeAccess(session, "ts");
  const deleteAccess = trashScopeAccess(session, "diary_trash_scopes");
  if (!access) throw new HttpError(403, "完全削除する権限がありません。");
  const entry = await env.DB.prepare(`
    SELECT e.id, e.revision,
      (SELECT COUNT(*) FROM diary_trash_scopes all_scopes WHERE all_scopes.entry_id = e.id) AS total_scopes,
      (SELECT COUNT(*) FROM diary_trash_scopes ts WHERE ts.entry_id = e.id AND ${access.clause}) AS accessible_scopes,
      (SELECT COUNT(*) FROM diary_photos p WHERE p.entry_id = e.id) AS photo_count
    FROM diary_entries e
    WHERE e.id = ? AND e.household_id = ? AND e.deleted_at IS NOT NULL
  `).bind(...access.bindings, id, session.activeHouseholdId).first();
  if (!entry || Number(entry.accessible_scopes || 0) < 1) {
    return json({ error: "完全削除する日記が見つかりません。" }, 404);
  }
  if (Number(entry.revision) !== revision) {
    return json({ error: "完全削除できませんでした。再読み込みしてください。" }, 409);
  }
  const removesLastScope = Number(entry.total_scopes) <= Number(entry.accessible_scopes);
  if (removesLastScope && Number(entry.photo_count) > 0 && !env.MEDIA) {
    throw new HttpError(503, "画像の保存先を確認できないため、完全削除を中止しました。");
  }
  const results = await env.DB.batch([env.DB.prepare(`
    DELETE FROM diary_trash_scopes
    WHERE entry_id = ? AND entry_revision = ? AND ${deleteAccess.clause}
  `).bind(id, revision, ...deleteAccess.bindings), env.DB.prepare(`
    DELETE FROM diary_entries
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM diary_trash_scopes ts WHERE ts.entry_id = diary_entries.id)
  `).bind(id, session.activeHouseholdId, revision)]);
  if (!results[0]?.meta?.changes) {
    return json({ error: "完全削除できませんでした。再読み込みしてください。" }, 409);
  }
  const physicallyDeleted = Boolean(results[1]?.meta?.changes);
  const mediaCleanupComplete = !physicallyDeleted || await drainMediaDeletionQueue(env, id);
  return json({ ok: true, physicallyDeleted, mediaCleanupPending: physicallyDeleted && !mediaCleanupComplete });
}

async function replaceTags(env, entryId, tags) {
  const statements = [env.DB.prepare("DELETE FROM diary_tags WHERE entry_id = ?").bind(entryId)];
  for (const tag of tags) {
    statements.push(env.DB.prepare("INSERT INTO diary_tags (entry_id, tag) VALUES (?, ?)").bind(entryId, tag));
  }
  await env.DB.batch(statements);
}

function validateEntryInput(body) {
  const entryDate = typeof body.entryDate === "string" ? body.entryDate.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!isValidDate(entryDate)) throw new HttpError(400, "日付を確認してください。");
  if (!title || title.length > 200) throw new HttpError(400, "タイトルは1文字以上200文字以内で入力してください。");
  if (!content || content.length > 200000) throw new HttpError(400, "本文は1文字以上20万文字以内で入力してください。");
  const rawTags = Array.isArray(body.tags) ? body.tags : [];
  const tags = [...new Set(rawTags.map(normalizeTag).filter(Boolean))];
  if (tags.length > 10 || tags.some((tag) => tag.length > 30)) {
    throw new HttpError(400, "タグは10個まで、1個30文字以内で入力してください。");
  }
  const contentFormat = validateContentFormat(body.contentFormat, content);
  return { entryDate, title, content, contentFormat, tags };
}

function validateContentFormat(value, content) {
  if (value == null || value === "") return null;
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.runs)) {
    throw new HttpError(400, "本文の書式情報を確認してください。");
  }
  if (value.runs.length > 5000) {
    throw new HttpError(400, "本文の書式が多すぎます。");
  }
  const colors = new Set(["red", "blue", "green", "orange", "purple", "gray", "light-blue", "brown"]);
  const normalized = [];
  let previousEnd = 0;
  for (const run of value.runs) {
    const start = Number(run?.start);
    const end = Number(run?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < previousEnd || start < 0 || end <= start || end > content.length) {
      throw new HttpError(400, "本文の書式範囲を確認してください。");
    }
    const color = run.color == null || run.color === "" ? null : String(run.color);
    if (color && !colors.has(color)) {
      throw new HttpError(400, "本文の文字色を確認してください。");
    }
    const item = {
      start,
      end,
      bold: run.bold === true,
      italic: run.italic === true,
      underline: run.underline === true,
      color
    };
    if (!item.bold && !item.italic && !item.underline && !item.color) {
      throw new HttpError(400, "本文の書式情報を確認してください。");
    }
    normalized.push(item);
    previousEnd = end;
  }
  return normalized.length ? JSON.stringify({ version: 1, runs: normalized }) : null;
}

function serializePhoto(row) {
  return {
    id: row.id,
    entryId: Number(row.entry_id),
    entryDate: row.entry_date || null,
    entryTitle: row.entry_title || null,
    authorId: row.author_id || null,
    authorName: row.author_name || null,
    fileName: row.file_name,
    contentType: row.content_type,
    originalSize: Number(row.original_size || 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    thumbnailUrl: `${BASE_PATH}/api/photos/${row.id}/thumbnail`,
    displayUrl: `${BASE_PATH}/api/photos/${row.id}/display`,
    originalUrl: `${BASE_PATH}/api/photos/${row.id}/original`
  };
}

function serializeEntry(row) {
  let tags = [];
  try {
    tags = JSON.parse(row.tags || "[]");
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id),
    entryDate: row.entry_date,
    title: row.title,
    content: row.content,
    contentFormat: parseContentFormat(row.content_format),
    authorId: row.author_id,
    authorName: row.author_name,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedById: row.deleted_by_id || null,
    deletedByName: row.deleted_by_name || null,
    revision: Number(row.revision)
  };
}

function parseContentFormat(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.version === 1 && Array.isArray(parsed.runs) ? parsed : null;
  } catch {
    return null;
  }
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;
  const expectedSignature = await sign(encodedPayload, env.SESSION_SECRET);
  if (!constantTimeEqual(base64UrlToBytes(encodedSignature), base64UrlToBytes(expectedSignature))) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(encodedPayload)));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const account = await findAccountById(payload.accountId, env);
    if (!account || account.role !== payload.role) return null;
    if (String(payload.version || "1") !== String(env.SESSION_VERSION || "1")) return null;
    if (Number(payload.accountVersion || 1) !== Number(account.sessionVersion || 1)) return null;
    const activeHouseholdId = account.isGlobalOwner && payload.activeHouseholdId
      ? payload.activeHouseholdId
      : account.householdId;
    if (account.isGlobalOwner && !["tanaka-household", "chiharu-household"].includes(activeHouseholdId)) return null;
    return {
      ...payload,
      accountName: account.name,
      loginId: accountLoginId(account, env),
      householdId: account.householdId,
      activeHouseholdId,
      isGlobalOwner: Boolean(account.isGlobalOwner),
      mustChangePassword: Boolean(account.mustChangePassword),
      canViewTrash: account.canViewTrash,
      canPermanentlyDelete: account.canPermanentlyDelete,
      canViewInvestment: account.canViewInvestment
    };
  } catch {
    return null;
  }
}

function getSessionMaxAge(env) {
  return clampNumber(env.SESSION_TTL_SECONDS, 3600, SESSION_TTL_SECONDS, SESSION_TTL_SECONDS);
}

async function withRollingSession(request, response, env, url, path) {
  if (path === "/api/login" || path === "/api/logout" || path === "/api/password/initial"
    || path === "/api/households/select" || response.status === 401) return response;
  const session = await readSession(request, env);
  if (!session) return response;
  const account = await findAccountById(session.accountId, env);
  if (!account) return response;

  const maxAge = getSessionMaxAge(env);
  const token = await createSessionToken(account, maxAge, env, session.activeHouseholdId);
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function createSessionToken(account, maxAge, env, activeHouseholdId = account.householdId) {
  const payload = {
    role: account.role,
    accountId: account.id,
    activeHouseholdId,
    accountVersion: Number(account.sessionVersion || 1),
    exp: Math.floor(Date.now() / 1000) + maxAge,
    version: String(env.SESSION_VERSION || "1")
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await sign(encodedPayload, env.SESSION_SECRET)}`;
}

function normalizeLoginId(value) {
  const loginId = String(value || "").trim().toLowerCase();
  return loginId && loginId.length <= 254 ? loginId : "";
}

function accountLoginId(account, env) {
  return normalizeLoginId(account.loginId || env[account.loginIdSecretKey]);
}

async function findAccountByLoginId(loginId, env) {
  const row = await env.DB.prepare(`
    SELECT id, household_id, display_name, login_id, password_hash, role,
           must_change_password, can_view_trash, can_permanently_delete,
           can_view_investment, session_version
    FROM diary_accounts WHERE login_id = ? AND active = 1
  `).bind(loginId).first();
  if (row) return databaseAccount(row);
  return DIARY_ACCOUNTS.find((account) => accountLoginId(account, env) === loginId) || null;
}

async function findAccountById(id, env) {
  const staticAccount = DIARY_ACCOUNTS.find((account) => account.id === id);
  if (staticAccount) return staticAccount;
  const row = await env.DB.prepare(`
    SELECT id, household_id, display_name, login_id, password_hash, role,
           must_change_password, can_view_trash, can_permanently_delete,
           can_view_investment, session_version
    FROM diary_accounts WHERE id = ? AND active = 1
  `).bind(id).first();
  return row ? databaseAccount(row) : null;
}

function databaseAccount(row) {
  const temporarySecretKeys = {
    "chiharu-admin": "DIARY_CHIHARU_TEMP_PASSWORD_HASH"
  };
  return {
    id: row.id,
    name: row.display_name,
    loginId: row.login_id,
    householdId: row.household_id,
    passwordHash: row.password_hash || null,
    temporarySecretKey: row.must_change_password ? (temporarySecretKeys[row.id] || null) : null,
    role: row.role,
    isGlobalOwner: false,
    mustChangePassword: Boolean(row.must_change_password),
    canViewTrash: Boolean(row.can_view_trash),
    canPermanentlyDelete: Boolean(row.can_permanently_delete),
    canViewInvestment: Boolean(row.can_view_investment),
    sessionVersion: Number(row.session_version || 1)
  };
}

async function changeInitialPassword(request, env, session, url) {
  if (!session.mustChangePassword) return json({ error: "初回パスワード設定は完了しています。" }, 409);
  const body = await readJson(request, 4096);
  const password = typeof body.password === "string" ? body.password : "";
  const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
  if (password !== confirmation) return json({ error: "確認用パスワードが一致しません。" }, 400);
  if (!isStrongPassword(password)) {
    return json({ error: "パスワードは6文字以上で入力してください。" }, 400);
  }
  const passwordHash = await createPasswordHash(password, env);
  const result = await env.DB.prepare(`
    UPDATE diary_accounts
    SET password_hash = ?, must_change_password = 0,
        session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND must_change_password = 1 AND active = 1
  `).bind(passwordHash, session.accountId).run();
  if (!result.meta?.changes) return json({ error: "パスワードを更新できませんでした。再度ログインしてください。" }, 409);
  const account = await findAccountById(session.accountId, env);
  const maxAge = getSessionMaxAge(env);
  const token = await createSessionToken(account, maxAge, env, account.householdId);
  const headers = new Headers();
  headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
  return json({
    authenticated: true,
    role: account.role,
    accountName: account.name,
    loginId: account.loginId,
    householdId: account.householdId,
    activeHouseholdId: account.householdId,
    isGlobalOwner: false,
    mustChangePassword: false,
    canViewTrash: account.canViewTrash,
    canPermanentlyDelete: account.canPermanentlyDelete,
    canViewInvestment: account.canViewInvestment
  }, 200, headers);
}

function isStrongPassword(password) {
  return password.length >= 6 && password.length <= 128;
}

async function createPasswordHash(password, env) {
  const pepper = env.DIARY_PASSWORD_PEPPER || env.SESSION_SECRET;
  if (!pepper) throw new HttpError(503, "パスワード設定を完了できません。管理者へご連絡ください。");
  return `hmac-sha256$${await sign(password, pepper)}`;
}

async function loginFingerprint(request, account, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const secret = env.LOGIN_FINGERPRINT_SECRET || env.SESSION_SECRET;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${ip}:${account.id}:${secret}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function recordFailedLogin(env, fingerprint, now) {
  const attempt = await env.DB.prepare("SELECT failed_count, first_failed_at FROM diary_login_attempts WHERE fingerprint = ?").bind(fingerprint).first();
  const inWindow = attempt && now - Number(attempt.first_failed_at) <= LOGIN_WINDOW_SECONDS;
  const failedCount = inWindow ? Number(attempt.failed_count) + 1 : 1;
  const firstFailedAt = inWindow ? Number(attempt.first_failed_at) : now;
  const lockedUntil = failedCount >= LOGIN_LIMIT ? now + LOGIN_WINDOW_SECONDS : null;
  await env.DB.prepare(`INSERT INTO diary_login_attempts (fingerprint, failed_count, first_failed_at, locked_until)
    VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET failed_count = excluded.failed_count,
    first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`)
    .bind(fingerprint, failedCount, firstFailedAt, lockedUntil).run();
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function verifyPassword(password, encodedHash, env = {}) {
  try {
    if (String(encodedHash).startsWith("hmac-sha256$")) {
      const [, hashText] = String(encodedHash).split("$");
      const pepper = env.DIARY_PASSWORD_PEPPER || env.SESSION_SECRET;
      if (!pepper) return false;
      const actual = await sign(password, pepper);
      return constantTimeEqual(base64UrlToBytes(actual), base64UrlToBytes(hashText));
    }
    if (String(encodedHash).startsWith("sha256$")) {
      const [, hashText] = String(encodedHash).split("$");
      const expected = base64UrlToBytes(hashText);
      const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(password)));
      return constantTimeEqual(actual, expected);
    }
    const [algorithm, iterationsText, saltText, hashText] = String(encodedHash).split("$");
    if (algorithm !== "pbkdf2-sha256") return false;
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(hashText);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      expected.length * 8
    ));
    return constantTimeEqual(derived, expected);
  } catch (error) {
    console.error("Password verification failed", error instanceof Error ? error.name : "unknown error");
    return false;
  }
}

function sessionCookie(token, maxAge, secure) {
  return `${SESSION_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure) {
  return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

function validMutationRequest(request, url) {
  return sameOrigin(request, url) && request.headers.get("X-Diary-Request") === "1";
}

async function readJson(request, maxBytes) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "入力内容を読み取れませんでした。");
  }
}

function requireAdmin(session) {
  if (session.role !== "admin") throw new HttpError(403, "この操作を行う権限がありません。");
}

function requireTrashAccess(session) {
  if (!session.canViewTrash || !trashScopeAccess(session)) {
    throw new HttpError(403, "ゴミ箱を操作する権限がありません。");
  }
}

function requirePermanentDeleteAccess(session) {
  if (!session.canPermanentlyDelete || !trashScopeAccess(session)) {
    throw new HttpError(403, "完全削除する権限がありません。");
  }
}

function trashScopeAccess(session, alias = "diary_trash_scopes") {
  if (!session) return null;
  if (session.isGlobalOwner && session.accountId === MAIN_ADMIN_ACCOUNT_ID) {
    if (session.activeHouseholdId === TANAKA_HOUSEHOLD_ID) {
      return {
        clause: `${alias}.household_id = ? AND ${alias}.owner_account_id = ? AND ${alias}.scope_type = 'admin-retention'`,
        bindings: [TANAKA_HOUSEHOLD_ID, MAIN_ADMIN_ACCOUNT_ID]
      };
    }
    if (session.activeHouseholdId === CHIHARU_HOUSEHOLD_ID) {
      return {
        clause: `${alias}.household_id = ? AND ${alias}.owner_account_id = ? AND ${alias}.scope_type = 'personal'`,
        bindings: [CHIHARU_HOUSEHOLD_ID, CHIHARU_ADMIN_ACCOUNT_ID]
      };
    }
    return null;
  }
  if (session.accountId === WIFE_ADMIN_ACCOUNT_ID && session.activeHouseholdId === TANAKA_HOUSEHOLD_ID) {
    return {
      clause: `${alias}.household_id = ? AND ${alias}.owner_account_id = ? AND ${alias}.scope_type = 'personal'
        AND EXISTS (
          SELECT 1 FROM diary_entries personal_entry
          WHERE personal_entry.id = ${alias}.entry_id
            AND personal_entry.author_id = ? AND personal_entry.deleted_by_id = ?
        )`,
      bindings: [TANAKA_HOUSEHOLD_ID, WIFE_ADMIN_ACCOUNT_ID, WIFE_ADMIN_ACCOUNT_ID, WIFE_ADMIN_ACCOUNT_ID]
    };
  }
  if (session.accountId === CHIHARU_ADMIN_ACCOUNT_ID && session.activeHouseholdId === CHIHARU_HOUSEHOLD_ID) {
    return {
      clause: `${alias}.household_id = ? AND ${alias}.owner_account_id = ? AND ${alias}.scope_type = 'personal'`,
      bindings: [CHIHARU_HOUSEHOLD_ID, CHIHARU_ADMIN_ACCOUNT_ID]
    };
  }
  return null;
}

function trashScopesForDeletion(entry, session) {
  if (entry.household_id === CHIHARU_HOUSEHOLD_ID) {
    return [{ ownerAccountId: CHIHARU_ADMIN_ACCOUNT_ID, scopeType: "personal" }];
  }
  const scopes = [{ ownerAccountId: MAIN_ADMIN_ACCOUNT_ID, scopeType: "admin-retention" }];
  if (entry.household_id === TANAKA_HOUSEHOLD_ID
    && entry.author_id === WIFE_ADMIN_ACCOUNT_ID
    && session.accountId === WIFE_ADMIN_ACCOUNT_ID) {
    scopes.unshift({ ownerAccountId: WIFE_ADMIN_ACCOUNT_ID, scopeType: "personal" });
  }
  return scopes;
}

async function canAccessTrashEntry(entryId, env, session) {
  if (!session.canViewTrash) return false;
  const access = trashScopeAccess(session, "ts");
  if (!access) return false;
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
    FROM diary_trash_scopes ts
    WHERE ts.entry_id = ? AND ${access.clause}
    LIMIT 1
  `).bind(entryId, ...access.bindings).first();
  return Boolean(row);
}

async function canAccessTrashEntryByPhoto(photoId, env, session) {
  if (!session.canViewTrash) return false;
  const access = trashScopeAccess(session, "ts");
  if (!access) return false;
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
    FROM diary_photos p
    JOIN diary_trash_scopes ts ON ts.entry_id = p.entry_id
    WHERE p.id = ? AND ${access.clause}
    LIMIT 1
  `).bind(photoId, ...access.bindings).first();
  return Boolean(row);
}

async function drainMediaDeletionQueue(env, entryId = null) {
  if (!env.MEDIA) return false;
  const condition = entryId == null ? "" : "WHERE entry_id = ?";
  const statement = env.DB.prepare(`
    SELECT id, object_key FROM diary_media_deletion_queue
    ${condition}
    ORDER BY id ASC
    LIMIT 300
  `);
  const result = entryId == null ? await statement.all() : await statement.bind(entryId).all();
  const rows = result.results || [];
  if (!rows.length) return true;
  try {
    await env.MEDIA.delete(rows.map((row) => row.object_key));
    const placeholders = rows.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM diary_media_deletion_queue WHERE id IN (${placeholders})`)
      .bind(...rows.map((row) => row.id)).run();
    return true;
  } catch (error) {
    console.error("Diary media cleanup deferred", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

function normalizeSearch(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeFilterDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!isValidDate(normalized)) throw new HttpError(400, "検索する日付を確認してください。");
  return normalized;
}

function validateDateRange(dateFrom, dateTo) {
  const from = dateFrom || dateTo;
  const to = dateTo || dateFrom;
  if (!from && !to) return { from: "", to: "" };
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (fromTime > toTime) throw new HttpError(400, "開始日は終了日以前の日付を選択してください。");
  if ((toTime - fromTime) / 86400000 > 29) throw new HttpError(400, "検索期間が長すぎます。期間を短くしてください。");
  return { from, to };
}

function normalizeTag(value) {
  return String(value || "").trim().replace(/^#+/, "").replace(/\s+/g, " ");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function normalizeFileName(value) {
  const normalized = String(value || "photo").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (normalized || "photo").slice(0, 240);
}

function stripExtension(value) {
  return String(value || "photo").replace(/\.[^.]+$/, "") || "photo";
}

function contentDisposition(fileName) {
  const fallback = normalizeFileName(fileName).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(normalizeFileName(fileName))}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function json(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BASE_PATH = "/diary";
const SESSION_COOKIE = "troom_diary_session";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
        return secureResponse(await handleApi(request, env, url, path));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return secureResponse(json({ error: "Method not allowed" }, 405));
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
    return json({ authenticated: Boolean(session), role: session?.role || null });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "不正なリクエストです。" }, 403);
    if (!env.DIARY_ADMIN_PASSWORD_HASH || !env.DIARY_VIEW_PASSWORD_HASH || !env.SESSION_SECRET) {
      return json({ error: "日記の認証設定が完了していません。" }, 503);
    }

    const body = await readJson(request, 4096);
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length > 256) {
      return json({ error: "パスワードを確認してください。" }, 400);
    }

    const [isAdmin, isViewer] = await Promise.all([
      verifyPassword(password, env.DIARY_ADMIN_PASSWORD_HASH),
      verifyPassword(password, env.DIARY_VIEW_PASSWORD_HASH)
    ]);
    const role = isAdmin ? "admin" : isViewer ? "viewer" : null;
    if (!role) return json({ error: "パスワードが違います。" }, 401);

    const maxAge = clampNumber(env.SESSION_TTL_SECONDS, 3600, 2592000, 2592000);
    const token = await createSessionToken(role, maxAge, env);
    const headers = new Headers();
    headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
    return json({ authenticated: true, role }, 200, headers);
  }

  if (path === "/api/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "不正なリクエストです。" }, 403);
    const headers = new Headers();
    headers.set("Set-Cookie", clearSessionCookie(url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const session = await readSession(request, env);
  if (!session) return json({ error: "ログインが必要です。" }, 401);

  if (request.method !== "GET" && !validMutationRequest(request, url)) {
    return json({ error: "不正なリクエストです。" }, 403);
  }

  if (path === "/api/entries" && request.method === "GET") {
    return listEntries(url, env, session);
  }

  if (path === "/api/entries" && request.method === "POST") {
    requireAdmin(session);
    return createEntry(request, env);
  }

  if (path === "/api/meta" && request.method === "GET") {
    return listMeta(env);
  }

  const entryMatch = path.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch && request.method === "GET") {
    return getEntry(Number(entryMatch[1]), env, session);
  }
  if (entryMatch && request.method === "PUT") {
    requireAdmin(session);
    return updateEntry(Number(entryMatch[1]), request, env);
  }
  if (entryMatch && request.method === "DELETE") {
    requireAdmin(session);
    return moveEntryToTrash(Number(entryMatch[1]), request, env);
  }

  const restoreMatch = path.match(/^\/api\/entries\/(\d+)\/restore$/);
  if (restoreMatch && request.method === "POST") {
    requireAdmin(session);
    return restoreEntry(Number(restoreMatch[1]), env);
  }

  return json({ error: "Not found" }, 404);
}

async function serveAsset(request, env, url, path) {
  if (!env.ASSETS) return new Response("Diary assets are not configured", { status: 503 });

  const assetPaths = new Map([
    ["/diary.css", "/diary.css"],
    ["/diary.js", "/diary.js"]
  ]);
  const isAppRoute = path === "/" || path.startsWith("/entry/") || path === "/trash";
  const assetPath = assetPaths.get(path) || (isAppRoute ? "/" : null);
  if (!assetPath) return new Response("Not found", { status: 404 });

  const assetUrl = new URL(assetPath, url.origin);
  const assetRequest = new Request(assetUrl, request);
  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", assetPath === "/" ? "no-store" : "public, max-age=3600");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function listEntries(url, env, session) {
  const limit = clampNumber(url.searchParams.get("limit"), 1, 50, 20);
  const offset = clampNumber(url.searchParams.get("offset"), 0, 1000000, 0);
  const query = normalizeSearch(url.searchParams.get("q") || "", 100);
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "")
    ? url.searchParams.get("month")
    : "";
  const tag = normalizeTag(url.searchParams.get("tag") || "");
  const trash = session.role === "admin" && url.searchParams.get("trash") === "1";

  const conditions = [trash ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
  const bindings = [];
  if (query) {
    conditions.push("(instr(e.title, ?) > 0 OR instr(e.content, ?) > 0)");
    bindings.push(query, query);
  }
  if (month) {
    conditions.push("substr(e.entry_date, 1, 7) = ?");
    bindings.push(month);
  }
  if (tag) {
    conditions.push("EXISTS (SELECT 1 FROM diary_tags filter_tag WHERE filter_tag.entry_id = e.id AND filter_tag.tag = ?)");
    bindings.push(tag);
  }

  const statement = `
    SELECT
      e.id, e.entry_date, e.title, e.content, e.created_at, e.updated_at,
      e.deleted_at, e.revision,
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
  const deletedClause = session.role === "admin" ? "" : "AND e.deleted_at IS NULL";
  const row = await env.DB.prepare(`
    SELECT
      e.id, e.entry_date, e.title, e.content, e.created_at, e.updated_at,
      e.deleted_at, e.revision,
      COALESCE((SELECT json_group_array(tag) FROM diary_tags dt WHERE dt.entry_id = e.id), '[]') AS tags
    FROM diary_entries e
    WHERE e.id = ? ${deletedClause}
  `).bind(id).first();
  return row ? json({ entry: serializeEntry(row) }) : json({ error: "日記が見つかりません。" }, 404);
}

async function listMeta(env) {
  const [months, tags] = await Promise.all([
    env.DB.prepare(`
      SELECT substr(entry_date, 1, 7) AS value, COUNT(*) AS count
      FROM diary_entries
      WHERE deleted_at IS NULL
      GROUP BY value
      ORDER BY value DESC
    `).all(),
    env.DB.prepare(`
      SELECT dt.tag AS value, COUNT(*) AS count
      FROM diary_tags dt
      JOIN diary_entries e ON e.id = dt.entry_id
      WHERE e.deleted_at IS NULL
      GROUP BY dt.tag
      ORDER BY count DESC, dt.tag ASC
    `).all()
  ]);
  return json({ months: months.results || [], tags: tags.results || [] });
}

async function createEntry(request, env) {
  const input = validateEntryInput(await readJson(request, 500000));
  const result = await env.DB.prepare(`
    INSERT INTO diary_entries (entry_date, title, content)
    VALUES (?, ?, ?)
  `).bind(input.entryDate, input.title, input.content).run();
  const id = Number(result.meta?.last_row_id);
  await replaceTags(env, id, input.tags);
  return getEntry(id, env, { role: "admin" });
}

async function updateEntry(id, request, env) {
  const body = await readJson(request, 500000);
  const input = validateEntryInput(body);
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return json({ error: "編集情報が不足しています。再読み込みしてください。" }, 400);
  }

  const result = await env.DB.prepare(`
    UPDATE diary_entries
    SET entry_date = ?, title = ?, content = ?, updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(input.entryDate, input.title, input.content, id, revision).run();

  if (!result.meta?.changes) {
    return json({ error: "別の端末で更新された可能性があります。再読み込みしてください。" }, 409);
  }
  await replaceTags(env, id, input.tags);
  return getEntry(id, env, { role: "admin" });
}

async function moveEntryToTrash(id, request, env) {
  const body = await readJson(request, 4096);
  const revision = Number(body.revision);
  const result = await env.DB.prepare(`
    UPDATE diary_entries
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(id, revision).run();
  return result.meta?.changes
    ? json({ ok: true })
    : json({ error: "削除できませんでした。再読み込みしてください。" }, 409);
}

async function restoreEntry(id, env) {
  const result = await env.DB.prepare(`
    UPDATE diary_entries
    SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ? AND deleted_at IS NOT NULL
  `).bind(id).run();
  return result.meta?.changes
    ? getEntry(id, env, { role: "admin" })
    : json({ error: "復元する日記が見つかりません。" }, 404);
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
  return { entryDate, title, content, tags };
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
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    revision: Number(row.revision)
  };
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
    if (!["admin", "viewer"].includes(payload.role)) return null;
    if (String(payload.version || "1") !== String(env.SESSION_VERSION || "1")) return null;
    return payload;
  } catch {
    return null;
  }
}

async function createSessionToken(role, maxAge, env) {
  const payload = {
    role,
    exp: Math.floor(Date.now() / 1000) + maxAge,
    version: String(env.SESSION_VERSION || "1")
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await sign(encodedPayload, env.SESSION_SECRET)}`;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function verifyPassword(password, encodedHash) {
  try {
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

function normalizeSearch(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeTag(value) {
  return String(value || "").trim().replace(/^#+/, "").replace(/\s+/g, " ");
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
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
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

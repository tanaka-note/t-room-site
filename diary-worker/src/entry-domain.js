/* Entry validation and public records are independent of storage and sessions. */
export function createDiaryEntryDomain({ HttpError, basePath }) {
  function validateEntryInput(body, { draft = false, allowEmptyContent = false } = {}) {
    const entryDate = typeof body.entryDate === "string" ? body.entryDate.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!isValidDate(entryDate)) throw new HttpError(400, "日付を確認してください。");
    if ((!draft && !title) || title.length > 200) throw new HttpError(400, "タイトルは1文字以上200文字以内で入力してください。");
    if ((!draft && !allowEmptyContent && !content) || content.length > 200000) throw new HttpError(400, "本文は1文字以上20万文字以内で入力してください。");
    const rawTags = Array.isArray(body.tags) ? body.tags : [];
    const tags = [...new Set(rawTags.map(normalizeTag).filter(Boolean))];
    if (tags.length > 100 || tags.some((tag) => tag.length > 30)) {
      throw new HttpError(400, "タグは100個まで、1個30文字以内で入力してください。");
    }
    const contentFormat = validateContentFormat(body.contentFormat, content);
    const excludedPhotoIds = parsePhotoIdList(body.excludedPhotoIds);
    const weather = body.weather ?? null;
    if (weather !== null && !["sunny", "cloudy", "partly_cloudy", "cloudy_rain", "rain", "heavy_rain", "thunder", "snow"].includes(weather)) {
      throw new HttpError(400, "天気を確認してください。");
    }
    return { entryDate, title, content, contentFormat, tags, excludedPhotoIds, weather };
  }

  function normalizeEntryStatus(value) {
    return value === "draft" ? "draft" : "published";
  }

  function parsePhotoIdList(value) {
    let source = value;
    if (typeof source === "string") {
      try { source = JSON.parse(source); } catch { source = []; }
    }
    if (!Array.isArray(source)) return [];
    return [...new Set(source.map((item) => String(item || "").toLowerCase()).filter(isUuid))];
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
      thumbnailUrl: `${basePath}/api/photos/${row.id}/thumbnail`,
      displayUrl: `${basePath}/api/photos/${row.id}/display`,
      originalUrl: `${basePath}/api/photos/${row.id}/original`
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
      lastPublishedAt: row.last_published_at ?? null,
      title: row.title,
      weather: row.weather ?? null,
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
      status: row.status || "published",
      isFavorite: Number(row.is_favorite || 0) === 1,
      draftOfEntryId: row.draft_of_entry_id == null ? null : Number(row.draft_of_entry_id),
      draftOfRevision: row.draft_of_revision == null ? null : Number(row.draft_of_revision),
      excludedPhotoIds: parsePhotoIdList(row.draft_excluded_photo_ids),
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

  function normalizeTag(value) {
    return String(value || "").trim().replace(/^#+/, "").replace(/\s+/g, " ");
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  return Object.freeze({ validateEntryInput, normalizeEntryStatus, parsePhotoIdList, validateContentFormat, serializePhoto, serializeEntry, parseContentFormat, normalizeTag, isUuid, isValidDate });
}

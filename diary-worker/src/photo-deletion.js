import { findPhotoMarkers, removeTextFromRichDocument } from "../public/diary-rich-text.js";

// The album deletes published photos immediately. The editor keeps its existing
// save-then-delete protocol; it must not gain an extra revision after saving.
export async function deleteAlbumPhoto(id, revision, env, session, HttpError) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new HttpError(400, "編集情報が不足しています。写真を開き直してください。");
  }
  if (!env.MEDIA) throw new HttpError(503, "画像の保存先を確認できないため、削除を中止しました。");
  id = id.toLowerCase();
  const entry = await env.DB.prepare(`
    SELECT e.id, e.content, e.content_format, e.revision
    FROM diary_photos p JOIN diary_entries e ON e.id = p.entry_id
    WHERE p.id = ? AND e.household_id = ? AND e.deleted_at IS NULL AND e.status = 'published'
  `).bind(id, session.activeHouseholdId).first();
  if (!entry) throw new HttpError(404, "削除する画像が見つかりません。");
  if (Number(entry.revision) !== revision) {
    throw new HttpError(409, "日記が更新されています。写真を開き直してください。");
  }
  let document = { content: entry.content, contentFormat: entry.content_format ? JSON.parse(entry.content_format) : null };
  for (const marker of findPhotoMarkers(entry.content)) {
    if (marker.id.toLowerCase() === id) document = removeTextFromRichDocument(document, marker.marker);
  }
  if (!document.content.trim()) {
    const other = await env.DB.prepare("SELECT id FROM diary_photos WHERE entry_id = ? AND id != ? LIMIT 1")
      .bind(entry.id, id).first();
    if (!other) throw new HttpError(409, "最後の写真を削除すると本文が空になります。日記を編集してから削除してください。");
  }

  const mutationId = crypto.randomUUID();
  const statements = [env.DB.prepare(`
    UPDATE diary_entries SET content = ?, content_format = ?, revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP, last_mutation_id = ?
    WHERE id = ? AND household_id = ? AND revision = ? AND deleted_at IS NULL AND status = 'published'
      AND EXISTS (SELECT 1 FROM diary_photos WHERE id = ? AND entry_id = diary_entries.id)
      AND NOT EXISTS (
        SELECT 1 FROM diary_entries draft WHERE draft.draft_of_entry_id = diary_entries.id
          AND draft.status = 'draft' AND draft.deleted_at IS NULL
      )
  `).bind(document.content, document.contentFormat ? JSON.stringify(document.contentFormat) : null,
    mutationId, entry.id, session.activeHouseholdId, revision, id)];
  for (const column of ["original_key", "display_key", "thumbnail_key"]) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)
      SELECT p.entry_id, p.${column} FROM diary_photos p JOIN diary_entries e ON e.id = p.entry_id
      WHERE p.id = ? AND e.id = ? AND e.last_mutation_id = ?
    `).bind(id, entry.id, mutationId));
  }
  statements.push(env.DB.prepare(`
    DELETE FROM diary_photos WHERE id = ? AND entry_id = ? AND EXISTS (
      SELECT 1 FROM diary_entries WHERE id = ? AND last_mutation_id = ?
    )
  `).bind(id, entry.id, entry.id, mutationId));
  const results = await env.DB.batch(statements);
  if (Number(results[0]?.meta?.changes) !== 1 || Number(results.at(-1)?.meta?.changes) !== 1) {
    throw new HttpError(409, "日記が更新されたか、編集中の下書きがあります。日記と下書きを確認してから写真を開き直してください。");
  }
  return { ok: true, entryId: Number(entry.id), revision: revision + 1, ...document };
}

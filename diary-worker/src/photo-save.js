// Return one authorized snapshot of lightweight metadata, without fetching R2
// objects or creating an archive. Original downloads recheck access individually.
export async function readPhotoSaveList(url, env, session, { normalizeFilterDate, HttpError }) {
  const from = normalizeFilterDate(url.searchParams.get("dateFrom"));
  const to = normalizeFilterDate(url.searchParams.get("dateTo"));
  if (!from || !to || from > to) throw new HttpError(400, "開始日と終了日を正しい順序で選択してください。");
  const result = await env.DB.prepare(`
    SELECT p.id, p.file_name, p.content_type, p.original_size
    FROM diary_entries e JOIN diary_photos p ON p.entry_id = e.id
    WHERE e.household_id = ? AND e.status = 'published' AND e.deleted_at IS NULL
      AND e.entry_date >= ? AND e.entry_date <= ?
    ORDER BY e.entry_date ASC, e.id ASC, p.created_at ASC, p.id ASC
  `).bind(session.activeHouseholdId, from, to).all();
  return { photos: (result.results || []).map(row => ({ id: row.id, fileName: row.file_name,
    contentType: row.content_type, originalSize: Number(row.original_size) })) };
}

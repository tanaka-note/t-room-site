// Historical regression fixture, copied verbatim from cloud-worker/src/index.js
// commit afe13397de4811c621d0b46e562c270caa5583cd. Do not modernize this deliberately unsafe code.
async function permanentlyDeleteFile(id, env, session) {
  requireDelete(session);
  const file = await env.DB.prepare("SELECT object_key, thumbnail_key, display_thumbnail_key, stream_uid FROM cloud_files WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
  if (!file) throw new HttpError(404, "ゴミ箱にファイルが見つかりません。");
  await env.FILES.delete(file.object_key);
  if (file.thumbnail_key) await env.FILES.delete(file.thumbnail_key);
  if (file.display_thumbnail_key) await env.FILES.delete(file.display_thumbnail_key);
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
  const rows = await env.DB.prepare("SELECT id, object_key, thumbnail_key, display_thumbnail_key, stream_uid FROM cloud_files WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 20").all();
  let deleted = 0;
  let deletedFolders = 0;
  let failed = 0;
  for (const file of rows.results || []) {
    try {
      await env.FILES.delete(file.object_key);
      if (file.thumbnail_key) await env.FILES.delete(file.thumbnail_key);
      if (file.display_thumbnail_key) await env.FILES.delete(file.display_thumbnail_key);
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


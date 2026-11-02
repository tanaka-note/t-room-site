// One-off migration uses the existing diary APIs and ordinary authenticated session.
// The local journal contains identifiers and progress, never cookies or image bytes.
export function validateManifest(manifest) {
  if (manifest?.version !== 1 || manifest.year !== 2025 || manifest.timezone !== 'Asia/Tokyo'
    || !/^[a-f0-9]{64}$/.test(manifest.id) || !Array.isArray(manifest.days)) throw new Error('移行データの形式が違います。');
  const ids = new Set();
  let previousDate = '';
  for (const day of manifest.days) {
    if (!/^2025-\d{2}-\d{2}$/.test(day.date) || day.date <= previousDate || day.title !== day.date
      || !isUuid(day.requestId) || !Array.isArray(day.photos) || !day.photos.length) throw new Error('日付の指定を確認してください。');
    previousDate = day.date;
    let previous = null;
    for (const photo of day.photos) {
      if (!isUuid(photo.id) || ids.has(photo.id) || photo.date !== day.date || !Number.isSafeInteger(photo.timestamp)
        || new Date((photo.timestamp + 9 * 3600) * 1000).toISOString().slice(0, 10) !== day.date
        || !photo.mimeType?.startsWith('image/') || typeof photo.fileName !== 'string'
        || photo.fileName.length > 255 || !Number.isInteger(photo.width) || !Number.isInteger(photo.height)
        || photo.width < 1 || photo.height < 1 || photo.width > 100000 || photo.height > 100000) throw new Error('画像の指定を確認してください。');
      if (previous && (photo.timestamp < previous.timestamp
        || (photo.timestamp === previous.timestamp && photo.fileName < previous.fileName))) throw new Error('写真が撮影日時順ではありません。');
      for (const [key, limit] of [['original', 60 * 1024 ** 2], ['display', 3 * 1024 ** 2], ['thumbnail', 700 * 1024]]) {
        const variant = photo[key];
        if (!variant || !/^photos\/[a-f0-9-]{36}\/[A-Za-z0-9.-]+$/.test(variant.path)
          || variant.path.split('/')[1] !== photo.id || !Number.isSafeInteger(variant.bytes)
          || variant.bytes < 1 || variant.bytes > limit || !/^[a-f0-9]{64}$/.test(variant.sha256)) throw new Error('画像ファイルの指定を確認してください。');
      }
      ids.add(photo.id);
      previous = photo;
    }
  }
  return manifest;
}

function isUuid(value) { return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value || ''); }
export function photoContent(day) { return day.photos.map(photo => `[[写真:${photo.id}]]`).join('\n'); }
export function entryMatches(entry, day) {
  const ids = new Set((entry.photos || []).map(photo => photo.id));
  return entry.entryDate === day.date && entry.title === day.title && entry.content === photoContent(day)
    && ids.size === day.photos.length && day.photos.every((photo, index) => entry.photos[index]?.id === photo.id);
}

export class PhotoMigration {
  constructor({ manifest, journal, api, readFile, saveJournal, destination, onProgress = () => {}, shouldStop = () => false }) {
    this.manifest = validateManifest(manifest);
    this.journal = journal || { version: 1, manifestId: manifest.id, destination, days: {} };
    if (this.journal.version !== 1 || this.journal.manifestId !== manifest.id
      || JSON.stringify(this.journal.destination) !== JSON.stringify(destination)) throw new Error('進捗のデータまたは保存先が一致しません。');
    Object.assign(this, { api, readFile, saveJournal, destination, onProgress, shouldStop });
  }

  async checkpoint() { await this.saveJournal(structuredClone(this.journal)); }

  async verifySession() {
    const session = await this.api('/session');
    if (!session.authenticated || !session.canManageEntries || session.activeHouseholdId !== this.destination.householdId
      || session.loginId !== this.destination.loginId || session.role !== this.destination.role) throw new Error('ログイン先が変更されています。同じアカウントでログインし直してください。');
  }

  async run({ through = '2025-12-31', maxDays = Infinity, verifyOnly = false } = {}) {
    await this.checkpoint(); // Prove that durable progress is writable before any mutation.
    let completed = 0;
    for (const day of this.manifest.days) {
      if (day.date > through || completed >= maxDays || this.shouldStop()) break;
      await this.verifySession();
      let record = this.journal.days[day.date];
      if (verifyOnly) {
        if (!record?.entryId || record.status !== 'complete') throw new Error(`${day.date}: 完了記録がありません。`);
        const entry = (await this.api(`/entries/${record.entryId}`)).entry;
        if (entry.status !== 'published' || !entryMatches(entry, day)) throw new Error(`${day.date}: 保存結果が一致しません。`);
        this.onProgress({ date: day.date, stage: 'verified', photos: day.photos.length });
        continue;
      }
      if (!record) {
        // A lost create response is recovered with the same durable requestId.
        const found = [];
        for (const draft of [false, true]) {
          let offset = 0;
          while (true) {
            const result = await this.api(`/entries?dateFrom=${day.date}&dateTo=${day.date}&limit=50&offset=${offset}${draft ? '&draft=1' : ''}`);
            found.push(...result.entries.filter(entry => entry.entryDate === day.date));
            if (!result.hasMore) break;
            offset += result.entries.length;
          }
        }
        // If a day already exists, create's requestId replay identifies whether it is ours.
        // Never create a new entry on an occupied date without a saved intent.
        if (found.length) throw new Error(`${day.date}: 既存の日記があります。上書きせず停止しました。`);
        record = this.journal.days[day.date] = { status: 'creating', requestId: day.requestId, uploaded: [] };
        await this.checkpoint();
      }
      let entry;
      if (!record.entryId) {
        entry = (await this.api('/entries', { method: 'POST', body: {
          requestId: day.requestId, entryDate: day.date, title: day.title, content: '', tags: [], status: 'draft'
        } })).entry;
        record.entryId = entry.id;
        record.status = 'uploading';
        await this.checkpoint();
      } else {
        entry = (await this.api(`/entries/${record.entryId}`)).entry;
      }
      if (entry.entryDate !== day.date || entry.title !== day.title) throw new Error(`${day.date}: 日記が変更されています。`);
      if (entry.status === 'published') {
        if (!entryMatches(entry, day)) throw new Error(`${day.date}: 投稿済みの日記が移行内容と一致しません。`);
        record.status = 'complete';
        await this.checkpoint();
        this.onProgress({ date: day.date, stage: 'complete', photos: day.photos.length });
        continue;
      }
      if (entry.status !== 'draft' || entry.content !== '' || entry.draftOfEntryId
        || (entry.photos || []).some(photo => !day.photos.some(p => p.id === photo.id))) throw new Error(`${day.date}: 下書きが変更されています。`);
      const existing = new Set((entry.photos || []).map(photo => photo.id));
      // Staging uses attempt-specific R2 keys, so a failed overlapping retry cannot
      // remove the successful attempt's objects. Final photographs have no staging TTL.
      if (record.uploadSessionId && Date.parse(record.uploadExpiresAt) <= Date.now()) {
        try { await this.api(`/photo-upload-sessions/${record.uploadSessionId}`, { method: 'DELETE' }); }
        catch (error) { if (error.status !== 404) throw error; }
        delete record.uploadSessionId;
        delete record.stagePhotoIds;
        record.uploaded = [...existing];
        await this.checkpoint();
      }
      let resumingSession = Boolean(record.uploadSessionId);
      if (!record.uploadSessionId && existing.size < day.photos.length) {
        const { uploadSession } = await this.api('/photo-upload-sessions', { method: 'POST', body: { targetEntryId: entry.id } });
        if (!isUuid(uploadSession?.id) || !Number.isFinite(Date.parse(uploadSession.expiresAt))) throw new Error('写真の一時保存情報が不正です。');
        record.uploadSessionId = uploadSession.id;
        record.uploadExpiresAt = uploadSession.expiresAt;
        record.stagePhotoIds = day.photos.filter(photo => !existing.has(photo.id)).map(photo => photo.id);
        record.uploaded = [...existing];
        await this.checkpoint();
      }
      const saved = new Set(existing);
      for (const photo of day.photos) {
        if (this.shouldStop()) { await this.checkpoint(); return; }
        if (!existing.has(photo.id) && resumingSession) {
          try {
            const result = await this.api(`/photo-upload-sessions/${record.uploadSessionId}/photos/${photo.id}`);
            if (result.photo?.id !== photo.id) throw new Error('写真の保存確認が一致しません。');
            saved.add(photo.id);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
        if (!saved.has(photo.id)) {
          const form = new FormData();
          form.set('id', photo.id);
          form.set('width', String(photo.width));
          form.set('height', String(photo.height));
          for (const key of ['original', 'display', 'thumbnail']) {
            const bytes = await this.readFile(photo[key].path);
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
            if (bytes.byteLength !== photo[key].bytes || digest !== photo[key].sha256) throw new Error(`${day.date}: 元データの検証に失敗しました。`);
            form.set(key, new Blob([bytes], { type: key === 'original' ? photo.mimeType : 'image/webp' }), key === 'original' ? photo.fileName : `${key}.webp`);
          }
          const result = await this.api(`/photo-upload-sessions/${record.uploadSessionId}/photos`, { method: 'POST', body: form });
          if (result.photo?.id !== photo.id) throw new Error('画像保存の応答が一致しません。');
          saved.add(photo.id);
        }
        record.uploaded = [...saved];
        await this.checkpoint();
        this.onProgress({ date: day.date, stage: 'uploading', uploaded: saved.size, photos: day.photos.length });
      }
      if (record.uploadSessionId) {
        record.status = 'committing';
        await this.checkpoint();
        await this.api(`/photo-upload-sessions/${record.uploadSessionId}/commit`, {
          method: 'POST', body: { entryId: entry.id, photoIds: record.stagePhotoIds }
        });
      }
      entry = (await this.api(`/entries/${entry.id}`)).entry;
      if (entry.status !== 'draft' || entry.entryDate !== day.date || entry.title !== day.title || entry.content !== ''
        || (entry.photos || []).length !== day.photos.length
        || !day.photos.every(photo => entry.photos.some(saved => saved.id === photo.id))) throw new Error(`${day.date}: 写真の照合に失敗しました。`);
      record.status = 'publishing';
      await this.checkpoint();
      // If PUT succeeds but its response is lost, the next run reconciles this published entry.
      await this.api(`/entries/${entry.id}`, { method: 'PUT', body: {
        entryDate: day.date, title: day.title, content: photoContent(day), tags: [], status: 'published', revision: entry.revision
      } });
      entry = (await this.api(`/entries/${entry.id}`)).entry;
      if (entry.status !== 'published' || !entryMatches(entry, day)) throw new Error(`${day.date}: 投稿後の照合に失敗しました。`);
      record.status = 'complete';
      await this.checkpoint();
      this.onProgress({ date: day.date, stage: 'complete', photos: day.photos.length });
      completed += 1;
    }
  }
}

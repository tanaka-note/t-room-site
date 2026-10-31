import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/diary.js", import.meta.url), "utf8");
const persistSource = source.slice(source.indexOf("  async function persistEditor("), source.indexOf("  async function createEntryIdempotently("));
const photoId = "11111111-1111-4111-8111-111111111111";

function fixture({ status = "published", draftOfEntryId = null, pending = false, failDelete = false, failCommit = false } = {}) {
  const entry = { id: 42, revision: 1, status, draftOfEntryId, excludedPhotoIds: [photoId],
    photos: pending ? [{ id: photoId, entryId: 42 }] : [] };
  const state = { editorPhotos: [], editorWeather: null, editorSourceEntry: entry, editorDirty: true,
    editorDeletedPhotoIds: new Set([photoId]), editorPendingPhotoDeletionIds: new Set(pending ? [photoId] : []),
    photoUploadSessionId: failCommit ? "session" : null, photoUploadCommitted: false };
  const elements = Object.fromEntries(Object.entries({ entryId: "42", entryRevision: "1", entryStatus: status,
    entryDate: "2026-10-31", entryTitle: "タイトルだけ変更", entryTags: "タグ" }).map(([key, value]) => [key, { value }]));
  elements.editorMessage = { textContent: "" };
  elements.editorLeaveDialog = { open: false };
  const writes = [], deletes = [];
  let closes = 0, deleteFails = failDelete, commitFails = failCommit;
  const context = { state, elements, editorSaveTiming: null, console: { info() {} },
    Date, Map, Set, JSON, Number, String, Boolean,
    waitForPhotoPreparation: async () => {}, serializeRichEditor: () => ({ content: "本文", contentFormat: null }),
    parseTags: value => [value], photoMarker: id => `[[写真:${id}]]`, setEditorSaveBusy() {},
    api: async (path, { body }) => {
      writes.push(structuredClone(body));
      const promoted = state.editorSourceEntry.draftOfEntryId && body.status === "published";
      return { entry: { ...entry, ...body, id: promoted ? 7 : Number(elements.entryId.value),
        draftOfEntryId: promoted ? null : state.editorSourceEntry.draftOfEntryId,
        photos: [], revision: Number(body.revision) + 1 } };
    },
    deletePhoto: async id => {
      deletes.push(id);
      if (!pending) throw new Error("削除する画像が見つかりません。");
      if (deleteFails) { deleteFails = false; throw new Error("一時的な削除失敗"); }
    },
    commitStagedPhotos: async () => { if (commitFails) { commitFails = false; throw new Error("一時的な写真確定失敗"); } return []; },
    renderEditorPhotos() {}, showToast() {}, updateFilterControls() {}, loadMeta: async () => {}, loadEntries: async () => {},
    closeEditorDialog: async () => { closes++; }
  };
  const persist = runInNewContext(`(${persistSource.trim()})`, context);
  return { state, elements, writes, deletes, persist, closes: () => closes };
}

// Stored exclusions are not new destructive actions, whether the entry was
// already published or is an ordinary draft being published for the first time.
for (const status of ["published", "draft"]) {
  const f = fixture({ status });
  assert.equal(await f.persist("published"), true);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.writes[0].title, "タイトルだけ変更");
  assert.equal(f.closes(), 1);
}

const genuine = fixture({ pending: true });
assert.equal(await genuine.persist("published"), true);
assert.deepEqual(genuine.deletes, [photoId]);
assert.equal(genuine.state.editorPendingPhotoDeletionIds.size, 0);

const retry = fixture({ pending: true, failDelete: true });
assert.equal(await retry.persist("published"), false);
assert.equal(retry.state.editorPendingPhotoDeletionIds.has(photoId), true);
assert.match(retry.elements.editorMessage.textContent, /一時的な削除失敗/);
assert.equal(await retry.persist("published"), true);
assert.deepEqual(retry.deletes, [photoId, photoId]);
assert.equal(retry.state.editorPendingPhotoDeletionIds.size, 0);

const inherited = fixture({ status: "draft", draftOfEntryId: 7, pending: true });
inherited.state.editorSourceEntry.photos[0].entryId = 7;
assert.equal(await inherited.persist("draft"), true);
assert.deepEqual(inherited.deletes, [], "draft save cannot delete a source entry photo");
assert.deepEqual(inherited.writes[0].excludedPhotoIds, [photoId]);

const promoted = fixture({ status: "draft", draftOfEntryId: 7, pending: true, failCommit: true });
assert.equal(await promoted.persist("published"), false);
assert.equal(promoted.state.editorPendingPhotoDeletionIds.size, 0,
  "draft publication already applied the pending exclusion in its transaction");
assert.equal(await promoted.persist("published"), true);
assert.deepEqual(promoted.deletes, [], "retry after photo-commit failure must not replay the published draft deletion");

const clearSource = source.slice(source.indexOf("  function clearEditorPhotos("), source.indexOf("  async function deletePhoto("));
const clearing = { editorPhotos: [], editorDeletedPhotoIds: new Set([photoId]), editorPendingPhotoDeletionIds: new Set([photoId]),
  photoUploadActiveTasks: new Set() };
runInNewContext(`(${clearSource.trim()})()`, { state: clearing, elements: {}, URL });
assert.equal(clearing.editorPendingPhotoDeletionIds.size, 0, "closing/reopening the editor clears current deletion intent");
assert.equal(clearing.editorDeletedPhotoIds.size, 0);
process.stdout.write("Photo deletion intent: historical exclusions, title edits, drafts, explicit deletion, retry and publish recovery passed.\n");

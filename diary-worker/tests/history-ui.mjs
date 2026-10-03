import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const script = await readFile(new URL("../public/diary.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
for (const id of ["entry-dialog", "editor-dialog", "camera-roll-dialog", "photo-viewer-dialog", "date-wheel-dialog", "delete-confirm-dialog", "editor-leave-dialog"]) {
  assert.ok(script.includes('dialogs.register("' + id + '"'), id);
}
assert.ok(html.includes('/diary/dialog-navigation.js?v=diary-'));
assert.ok(script.includes('elements.photoInput.addEventListener("cancel", handlePhotoPickerCancel)'));
assert.match(script, /function handlePhotoPickerCancel\(event\) \{\s*event\.stopPropagation\(\);\s*finishPhotoPickerInteraction\(\);\s*\}/);
assert.ok(script.includes('state.editorSaving || state.photoPreparing || state.photoPickerActive'));
assert.doesNotMatch(script, /pushEntryHistory|pushEditorHistory|DESKTOP_DIALOG_BACKDROP_MATCHER/);
console.log("Diary shared navigation integration contracts passed.");

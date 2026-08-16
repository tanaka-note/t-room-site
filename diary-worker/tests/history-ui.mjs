import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8")
]);

assert.match(html, /diary\.js\?v=diary-[a-f0-9]{12}/);
assert.match(script, /const ENTRY_HISTORY_KEY = "troomDiaryEntry"/);
assert.match(script, /elements\.entryDialog\.showModal\(\);\s*pushEntryHistory\(\);/);
assert.match(script, /window\.history\.pushState\(/);
const pushEntryHistoryBody = script.match(/function pushEntryHistory\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
assert.doesNotMatch(pushEntryHistoryBody, /searchInput\.value|dateFrom\.value|dateTo\.value|tagSearchInput\.value/);
assert.match(script, /if \(state\.entryClosePending\) return/);
assert.match(script, /state\.entryClosePending = true;\s*window\.history\.back\(\);/s);
assert.match(script, /window\.addEventListener\("popstate", handleHistoryNavigation\)/);
assert.match(script, /function handleHistoryNavigation\(\)[\s\S]*?if \(state\.entryHistoryToken && elements\.entryDialog\.open\) finishEntryClose\(\);/);
assert.match(script, /const EDITOR_HISTORY_KEY = "troomDiaryEditor"/);
assert.match(script, /function requestEditorClose\(\)/);
assert.match(script, /function discardEditorChanges\(\)/);
assert.match(script, /elements\.entryDialog\.addEventListener\("cancel", \(event\) => \{\s*event\.preventDefault\(\);\s*closeEntryDialog\(\);/s);
assert.match(script, /const DESKTOP_DIALOG_BACKDROP_MATCHER = "\(min-width: 861px\) and \(hover: hover\) and \(pointer: fine\)"/);
assert.match(script, /function isDesktopDialogBackdropEnabled\(\) \{\s*return window\.matchMedia\(DESKTOP_DIALOG_BACKDROP_MATCHER\)\.matches;\s*\}/);
assert.match(script, /bindDesktopBackdropClose\(elements\.entryDialog, closeEntryDialog\)/);
assert.match(script, /bindDesktopBackdropClose\(elements\.editorDialog, requestEditorClose\)/);
assert.match(script, /function bindDesktopBackdropClose\(dialog, onClose\)[\s\S]*?"pointerdown"[\s\S]*?"pointerup"[\s\S]*?pointerId !== event\.pointerId[\s\S]*?onClose\(\)/);
assert.match(script, /function isDesktopDialogBackdropPointer\(event, dialog\)[\s\S]*?if \(state\.photoPickerActive\) return false[\s\S]*?event\.target !== dialog[\s\S]*?getBoundingClientRect\(\)/);
assert.doesNotMatch(script, /addEventListener\("click", close(?:Entry|Editor)FromDesktopBackdrop\)/);
assert.match(script, /if \(id === "entry-dialog"\) \{\s*closeEntryDialog\(\);\s*return;\s*\}/s);

assert.match(script, /const CAMERA_ROLL_HISTORY_KEY = "troomDiaryCameraRoll"/);
assert.match(script, /const PHOTO_VIEWER_HISTORY_KEY = "troomDiaryPhotoViewer"/);
assert.match(script, /elements\.cameraRollDialog\.showModal\(\);\s*pushCameraRollHistory\(\);/);
assert.match(script, /elements\.photoViewerDialog\.showModal\(\);\s*pushPhotoViewerHistory\(\);/);
assert.match(script, /function handleHistoryNavigation\(\)[\s\S]*?finishPhotoViewerClose\(\)[\s\S]*?finishCameraRollClose\(\)[\s\S]*?finishEditorClose\(\)[\s\S]*?finishEntryClose\(\)/);
assert.match(script, /if \(id === "camera-roll-dialog"\)[\s\S]*?closeCameraRollDialog\(\)/);
assert.match(script, /if \(id === "photo-viewer-dialog"\)[\s\S]*?closePhotoViewerDialog\(\)/);
assert.match(script, /elements\.photoInput\.addEventListener\("cancel", handlePhotoPickerCancel\)/);
assert.match(script, /function handlePhotoPickerCancel\(event\) \{\s*event\.stopPropagation\(\);\s*finishPhotoPickerInteraction\(\);\s*\}/);
assert.match(script, /elements\.editorDialog\.addEventListener\("cancel", \(event\) => \{\s*if \(event\.target !== elements\.editorDialog\) return;\s*event\.preventDefault\(\);\s*requestEditorClose\(\);/s);
assert.match(script, /function openPhotoPicker\(\)[\s\S]*?state\.photoPickerActive = true[\s\S]*?window\.addEventListener\("focus", photoPickerReturnHandler, \{ once: true \}\)[\s\S]*?elements\.photoInput\.click\(\)/);
assert.match(script, /function handlePhotoSelection\(\) \{\s*finishPhotoPickerInteraction\(\)/);

process.stdout.write("Diary layered dialog history and desktop backdrop behavior test passed.\n");

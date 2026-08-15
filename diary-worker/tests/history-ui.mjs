import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8")
]);

assert.match(html, /diary\.js\?v=55/);
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
assert.match(script, /elements\.entryDialog\.addEventListener\("click", closeEntryFromDesktopBackdrop\)/);
assert.match(script, /const DESKTOP_DIALOG_BACKDROP_MATCHER = "\(min-width: 861px\) and \(hover: hover\) and \(pointer: fine\)"/);
assert.match(script, /function isDesktopDialogBackdropEnabled\(\) \{\s*return window\.matchMedia\(DESKTOP_DIALOG_BACKDROP_MATCHER\)\.matches;\s*\}/);
assert.match(script, /function closeDialogFromBackdrop\(event, dialog, onClose\) \{\s*if \(event\.target !== dialog\) return;\s*if \(!isDesktopDialogBackdropEnabled\(\)\) return;\s*onClose\(\);\s*\}/);
assert.match(script, /function closeEntryFromDesktopBackdrop\(event\) \{\s*closeDialogFromBackdrop\(event, elements\.entryDialog, closeEntryDialog\);\s*\}/);
assert.match(script, /function closeEditorFromDesktopBackdrop\(event\) \{\s*closeDialogFromBackdrop\(event, elements\.editorDialog, requestEditorClose\);\s*\}/);
assert.match(script, /elements\.editorDialog\.addEventListener\("click", closeEditorFromDesktopBackdrop\)/);
assert.match(script, /if \(id === "entry-dialog"\) \{\s*closeEntryDialog\(\);\s*return;\s*\}/s);

process.stdout.write("Diary entry history behavior test passed.\n");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(`${root}/public/diary.js`, "utf8");

assert.match(script, /const RETURN_VIEW_STORAGE_KEY = "troom-diary-return-view-v1"/);
assert.match(script, /const RETURN_VIEW_HISTORY_KEY = "troomDiaryReturnView"/);
assert.match(script, /document\.addEventListener\("click", rememberDiaryReturnViewFromNavigation, true\)/);
assert.match(script, /window\.addEventListener\("pageshow", restoreDiaryReturnViewFromPageCache\)/);
assert.match(script, /function storeDiaryReturnView\(destinationPath = ""\)[\s\S]*?routePath: window\.location\.pathname,[\s\S]*?query: state\.query,[\s\S]*?monthExpanded: state\.monthExpanded,[\s\S]*?tagQuery: state\.tagQuery,[\s\S]*?tagQueryInput: elements\.tagSearchInput\.value,[\s\S]*?entryCount: state\.entries\.length,[\s\S]*?tagListPosition: captureTagListPosition\(\)/s);
assert.match(script, /window\.history\.replaceState\([\s\S]*?\[RETURN_VIEW_HISTORY_KEY\]: returnView/s);
assert.match(script, /function applyDiaryReturnView\(returnView\)[\s\S]*?elements\.searchInput\.value = state\.query;[\s\S]*?elements\.tagSearchInput\.value = String\(returnView\.tagQueryInput \|\| returnView\.tagQuery/s);
assert.match(script, /elements\.appView\.hidden = false;[\s\S]*?await loadEntries\(true, true, returnView\?\.entryCount \|\| 0\);[\s\S]*?if \(loaded && returnView\) restoreDiaryReturnPosition\(returnView, restoreVersion\);/s);
assert.match(script, /function restoreEntryListPosition\(position\)[\s\S]*?window\.scrollTo\(\{ top: position\.scrollY, left: 0, behavior: "instant" \}\);/s);
assert.match(script, /function captureTagListPosition\(\)[\s\S]*?tag: visibleTag\?\.dataset\.tag[\s\S]*?scrollTop: elements\.tagList\.scrollTop/s);
assert.match(script, /function restoreTagListPosition\(position\)[\s\S]*?elements\.tagList\.scrollTo[\s\S]*?elements\.tagList\.scrollBy/s);
assert.match(script, /function restoreDiaryReturnPosition[\s\S]*?restoreEntryListPosition\(returnView\.position\);[\s\S]*?restoreTagListPosition\(returnView\.tagListPosition\);[\s\S]*?schedulePositionRestoration\(restore, version\);/s);
assert.doesNotMatch(script, /setTimeout\(restore, (120|400)\)/);
assert.doesNotMatch(script, /else if \(isNewDiaryNavigation\(\)\) restoreEntryListPosition/);
assert.match(script, /if \(returnView\.householdId && householdId && returnView\.householdId !== householdId\) return false;/);
assert.match(script, /link === elements\.tagPageBack \|\| \(link === elements\.favoritesLink && state\.favoritePage\)[\s\S]*?hasDiaryReturnNavigation\(destination\.pathname\)[\s\S]*?window\.history\.back\(\)/s);

process.stdout.write("Diary navigation return-state test passed.\n");

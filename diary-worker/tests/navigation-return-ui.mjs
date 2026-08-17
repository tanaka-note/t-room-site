import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(`${root}/public/diary.js`, "utf8");

assert.match(script, /const RETURN_VIEW_STORAGE_KEY = "troom-diary-return-view-v1"/);
assert.match(script, /document\.addEventListener\("click", rememberDiaryReturnViewFromNavigation, true\)/);
assert.match(script, /window\.addEventListener\("pageshow", restoreDiaryReturnViewFromPageCache\)/);
assert.match(script, /function storeDiaryReturnView\(\)[\s\S]*?query: state\.query,[\s\S]*?monthExpanded: state\.monthExpanded,[\s\S]*?tagQuery: state\.tagQuery,[\s\S]*?tagQueryInput: elements\.tagSearchInput\.value,[\s\S]*?entryCount: state\.entries\.length,[\s\S]*?position/s);
assert.match(script, /function applyDiaryReturnView\(returnView\)[\s\S]*?elements\.searchInput\.value = state\.query;[\s\S]*?elements\.tagSearchInput\.value = String\(returnView\.tagQueryInput \|\| returnView\.tagQuery/s);
assert.match(script, /await Promise\.all\(\[loadHouseholdSwitcher\(\), loadMeta\(\), loadEntries\(true\)\]\);\s*if \(returnView\) \{\s*await loadEntriesForDiaryReturn\(returnView\.entryCount\);\s*\}\s*elements\.bootView\.hidden = true;\s*elements\.loginView\.hidden = true;\s*elements\.appView\.hidden = false;[\s\S]*?if \(returnView\) restoreDiaryReturnPosition\(returnView\.position\);/s);
assert.match(script, /function restoreEntryListPosition\(position\) \{\s*if \(!position\) return;[\s\S]*?window\.scrollTo\(\{ top: position\.scrollY, left: 0, behavior: "auto" \}\);/s);
assert.match(script, /function restoreDiaryReturnPosition\(position\)[\s\S]*?window\.scrollTo\(\{ top: scrollY, left: 0, behavior: "auto" \}\);/s);
assert.match(script, /if \(returnView\.householdId && householdId && returnView\.householdId !== householdId\) return null;/);

process.stdout.write("Diary navigation return-state test passed.\n");

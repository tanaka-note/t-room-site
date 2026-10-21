import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(`${root}/public/diary.js`, "utf8");

assert.match(script, /const RETURN_VIEW_STORAGE_KEY = "troom-diary-return-view-v1"/);
assert.match(script, /const RETURN_VIEW_HISTORY_KEY = "troomDiaryReturnView"/);
assert.match(script, /document\.addEventListener\("click", rememberDiaryReturnViewFromNavigation, true\)/);
assert.match(script, /window\.addEventListener\("pageshow", restoreDiaryReturnViewFromPageCache\)/);
assert.match(script, /function storeDiaryReturnView\(destinationPath = "", \{ historyOnly = false \} = \{\}\)[\s\S]*?routePath: window\.location\.pathname,[\s\S]*?query: state\.query,[\s\S]*?monthExpanded: state\.monthExpanded,[\s\S]*?tagQuery: state\.tagQuery,[\s\S]*?tagQueryInput: elements\.tagSearchInput\.value,[\s\S]*?entryCount: state\.entries\.length,[\s\S]*?tagListPosition: captureTagListPosition\(\)/s);
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

// Execute the production helpers with browser state; these cases must exercise
// acceptance and consumption, rather than merely assert the source's shape.
const helpers = ["isNewDiaryNavigation", "isDiaryReturnReferrer", "isDiaryListPath", "configureDiaryReturnNavigation"]
  .map((name) => script.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0]).join("\n");
function configure({ sourcePath = "/diary/", referrer = "https://diary.test/diary/", age = 10,
  savedAt = 100_000, type = "navigate", snapshot = {}, raw, storageBlocked = false, historyToken = "old-token", repeat = false } = {}) {
  const navigation = { savedAt, sourcePath, destinationPath: "/diary/favorites/" };
  const view = { version: 2, routePath: sourcePath, destinationPath: navigation.destinationPath, savedAt, ...snapshot };
  const storage = new Map([
    ["handoff", raw === undefined ? JSON.stringify(navigation) : raw],
    ["view", JSON.stringify(view)]
  ]);
  const history = { state: { unrelated: "preserved", handoff: historyToken },
    replaceState(value) { this.state = value; } };
  const backLink = { hidden: false, href: "/diary/", textContent: "← 日記へ戻る" };
  runInNewContext(`${helpers}\nconfigureDiaryReturnNavigation();${repeat ? "configureDiaryReturnNavigation();" : ""}`, {
    URL, Date: { now: () => 100_010 }, Number, JSON, BASE_PATH: "/diary",
    RETURN_NAVIGATION_KEY: "handoff", RETURN_VIEW_STORAGE_KEY: "view",
    RETURN_NAVIGATION_MAX_AGE_MS: 30_000, RETURN_VIEW_MAX_AGE_MS: 6 * 60 * 60 * 1000,
    elements: { tagPageBack: backLink },
    document: { referrer },
    window: {
      history, location: new URL("https://diary.test/diary/favorites/"),
      performance: { timeOrigin: 100_000 + age, getEntriesByType: () => [{ type }] },
      sessionStorage: {
        getItem(key) { if (storageBlocked) throw Error("blocked"); return storage.get(key); },
        removeItem: (key) => storage.delete(key)
      }
    }
  });
  assert.equal(history.state.unrelated, "preserved");
  if (!storageBlocked) assert.equal(storage.has("handoff"), false, "handoff is consumed even when rejected");
  return { token: history.state.handoff, backLink };
}
assert.equal(configure().token, 100_000, "normal internal navigation accepts its handoff");
for (const options of [
  { referrer: "https://diary.test/diary/tags/" }, // interrupted handoff followed by another screen
  { referrer: "" },
  { referrer: "https://other.test/diary/" },
  { sourcePath: undefined, raw: JSON.stringify({ savedAt: 100_000, destinationPath: "/diary/favorites/" }) },
  { age: 30_001 }, { age: -1 }, { savedAt: "100000" }, { savedAt: null },
  { snapshot: { savedAt: 99_999 } }, { snapshot: { routePath: "/diary/tags/" } },
  { snapshot: { destinationPath: "/diary/tags/" } }, { snapshot: { version: 1 } },
  { raw: "invalid JSON" }, { raw: "null" }, { storageBlocked: true }
]) {
  const result = configure(options);
  assert.equal(result.token, undefined, `reject stale/unverifiable handoff: ${JSON.stringify(options)}`);
  assert.equal(result.backLink.href, "/diary/", "rejected handoff keeps the default return destination");
  assert.equal(result.backLink.textContent, "← 日記へ戻る");
}
assert.equal(configure({ type: "reload" }).token, "old-token", "reload preserves the owned history token without accepting a handoff");
assert.equal(configure({ type: "back_forward" }).token, "old-token", "Back/Forward preserves the owned history token");

for (const type of ["navigate", "reload", "back_forward"]) {
  const result = configure({ type, sourcePath: "/diary/tags/", referrer: "https://diary.test/diary/tags/", historyToken: 100_000 });
  assert.equal(result.backLink.href, "/diary/tags/", `${type}: owned navigation displays its source`);
  assert.equal(result.backLink.textContent, "← 前の画面へ戻る");
}
for (const type of ["reload", "back_forward"]) {
  const result = configure({ type, sourcePath: "/diary/tags/" });
  assert.equal(result.backLink.href, "/diary/", `${type}: unrelated history token cannot display a stale source`);
  assert.equal(result.backLink.textContent, "← 日記へ戻る");
}
const interrupted = configure({ sourcePath: "/diary/tags/", referrer: "https://diary.test/intermediate" });
assert.equal(interrupted.backLink.href, "/diary/");
assert.equal(interrupted.backLink.textContent, "← 日記へ戻る");
const repeated = configure({ sourcePath: "/diary/tags/", referrer: "https://diary.test/diary/tags/", repeat: true });
assert.equal(repeated.token, undefined);
assert.equal(repeated.backLink.href, "/diary/", "reconfiguration clears a previously displayed source");
assert.equal(repeated.backLink.textContent, "← 日記へ戻る");

process.stdout.write("Diary navigation return-state test passed.\n");

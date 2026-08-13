import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const helperMatch = script.match(/function shouldShowEntryAuthor\(\) \{[\s\S]*?\n  \}/);

assert.ok(helperMatch, "household-specific author visibility helper must exist");

function showAuthor(activeHouseholdId) {
  const context = { state: { activeHouseholdId } };
  vm.runInNewContext(`${helperMatch[0]}; globalThis.result = shouldShowEntryAuthor();`, context);
  return context.result;
}

assert.equal(showAuthor("chiharu-household"), false, "Chiharu diary must not display entry authors");
assert.equal(showAuthor("tanaka-household"), true, "Tanaka diary must retain entry authors");
assert.match(script, /meta\.append\(time\);\s*if \(shouldShowEntryAuthor\(\)\) meta\.append\(author\);/);
assert.match(script, /elements\.detailAuthor\.hidden = !shouldShowEntryAuthor\(\);/);
assert.match(script, /elements\.photoAuthorFilter\.closest\("label"\)\.hidden = hideAuthors;/);
assert.doesNotMatch(script, /DELETE FROM diary_entries|UPDATE diary_entries SET author/);

process.stdout.write("Diary Chiharu author visibility test passed.\n");

import assert from "node:assert/strict";
import { splitSearchTerms, findSearchMatches, createSearchExcerpt } from "../public/diary-search.js";

const count = (text) => [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].length;
assert.deepEqual(splitSearchTerms(" ふゆ　 公園  ふゆ　お弁当 "), ["ふゆ", "公園", "お弁当"]);
assert.deepEqual(splitSearchTerms(" 　 \t\n"), []);
assert.deepEqual(splitSearchTerms("ABC abc"), ["ABC", "abc"]);
assert.deepEqual(findSearchMatches("<b>100%_ & A+B 😀</b>", ["<b>", "%_", "A+B", "😀"]).map((hit) => hit.term), ["<b>", "%_", "A+B", "😀"]);

const body = "朝".repeat(200) + "ふゆと公園に行った。" + "道".repeat(220) + "お弁当を食べた。" + "夕".repeat(200);
const excerpt = createSearchExcerpt(body, ["ふゆ", "公園", "お弁当"]);
assert.ok(count(excerpt) <= 160);
for (const term of ["ふゆ", "公園", "お弁当"]) assert.ok(excerpt.includes(term), excerpt);
assert.ok(excerpt.indexOf("公園") < excerpt.indexOf("お弁当"));
assert.equal(excerpt.split("…").filter(Boolean).length, 2);
assert.ok(excerpt.startsWith("…") && excerpt.endsWith("…"));
const nearby = createSearchExcerpt("前".repeat(200) + "ふゆと公園でお弁当" + "後".repeat(200), ["ふゆ", "公園", "お弁当"]);
assert.equal(nearby.split("…").filter(Boolean).length, 1);
const repeated = createSearchExcerpt("公園に行った。".repeat(250) + "ふゆとお弁当。" + "後".repeat(200), ["公園", "ふゆ", "お弁当"]);
for (const term of ["ふゆ", "公園", "お弁当"]) assert.ok(repeated.includes(term), repeated);
const distant = createSearchExcerpt("a" + "前".repeat(250) + "b" + "中".repeat(250) + "c" + "後".repeat(250), ["a", "b", "c"]);
assert.ok(count(distant) <= 160);
assert.ok(distant.split("…").filter(Boolean).length <= 2);
assert.equal(["a", "b", "c"].filter((term) => distant.includes(term)).length, 2);
assert.equal(createSearchExcerpt("冒頭" + "本".repeat(200), ["タイトルのみ"]), "冒頭" + "本".repeat(157) + "…");
assert.equal(createSearchExcerpt("短い公園の日記", ["公園"]), "短い公園の日記");
const emoji = "👨‍👩‍👧‍👦👍🏽🇯🇵が";
const emojiExcerpt = createSearchExcerpt(emoji.repeat(80) + "公園" + emoji.repeat(80), ["公園"]);
assert.ok(count(emojiExcerpt) <= 160);
assert.ok(emojiExcerpt.includes("公園"));
assert.ok(!/(?:^|…)\u200d|\u200d(?:…|$)/u.test(emojiExcerpt));
for (const segment of new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(emojiExcerpt)) {
  assert.ok(["👨‍👩‍👧‍👦", "👍🏽", "🇯🇵", "が", "公", "園", "…"].includes(segment.segment));
}
const longTerm = "語".repeat(100);
assert.ok(createSearchExcerpt("前".repeat(200) + longTerm + "後".repeat(200), [longTerm]).includes(longTerm));
for (const terms of [["ああ"], ["ああ", "あああ"], ["語".repeat(90), "語".repeat(100)]]) {
  const result = createSearchExcerpt(terms.at(-1).repeat(250), terms);
  assert.ok(count(result) <= 160);
  assert.ok(result.includes(terms.at(-1)), "overlapping repetitions retain a complete match");
}
for (let gap = 0; gap < 220; gap += 1) {
  const result = createSearchExcerpt("前".repeat(170) + "ふゆ" + "中".repeat(gap) + "公園" + "後".repeat(170), ["ふゆ", "公園"]);
  assert.ok(count(result) <= 160, `gap=${gap}: ${count(result)}`);
  assert.ok(result.split("…").filter(Boolean).length <= 2);
  assert.ok(!/ふ…|…ゆ|公…|…園/.test(result), result);
}
console.log("Diary search tokenization, literal matches and bounded/diverse/grapheme-safe excerpts passed.");

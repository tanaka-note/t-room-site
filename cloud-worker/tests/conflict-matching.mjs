import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const extract = (start, end) => {
  const match = source.match(new RegExp(`function ${start}\\([\\s\\S]*?(?=\\n(?:async )?function ${end}\\()`));
  assert.ok(match, `${start} を読み取れません。`);
  return match[0];
};
const script = [
  extract("normalizeUploadName", "uploadFileIdentity"),
  extract("conflictTimestampIdentity", "conflictSizesAreNear"),
  extract("conflictSizesAreNear", "conflictPairReasons"),
  extract("conflictPairReasons", "buildConflictGroups"),
  extract("buildConflictGroups", "loadConflictOverview")
].join("\n");
const context = { Map, Set, Number, String, Math };
vm.createContext(context);
vm.runInContext(`${script}\nthis.buildGroups = buildConflictGroups;`, context);

const files = [
  { id: 1, topFolderId: 10, name: "movie.mp4", sizeBytes: 100_000_000, lastModified: 1000 },
  { id: 2, topFolderId: 10, name: "ＭＯＶＩＥ.mp4", sizeBytes: 100_300_000, lastModified: 2000 },
  { id: 3, topFolderId: 10, name: "photo-a.jpg", sizeBytes: 4_000_000, lastModified: 3000 },
  { id: 4, topFolderId: 10, name: "photo-b.jpg", sizeBytes: 4_000_000, lastModified: 3000 },
  { id: 5, topFolderId: 20, name: "movie.mp4", sizeBytes: 100_000_000, lastModified: 1000 },
  { id: 6, topFolderId: 10, name: "movie.mp4", sizeBytes: 150_000_000, lastModified: 1000 }
];
const folders = new Map([[10, { name: "Atsushi" }], [20, { name: "Masami" }]]);
const groups = context.buildGroups(files, folders);

assert.equal(groups.length, 2, "2条件が一致する競合候補だけを作成してください。");
assert.ok(groups.every((group) => group.topFolderId === 10), "トップフォルダをまたいで競合判定しないでください。");
assert.ok(groups.some((group) => group.reasons.includes("同じ名前") && group.reasons.includes("容量が近い")), "同名かつ近い容量を候補にしてください。");
assert.ok(groups.some((group) => group.reasons.includes("同じ容量") && group.reasons.includes("更新日時が同じ")), "同容量かつ同更新日時を候補にしてください。");
assert.ok(groups.every((group) => !group.files.some((file) => file.id === 6)), "名前・更新日時が同じでも数十MB違うデータを候補にしないでください。");

console.log("top-folder scoped conflict matching: ok");

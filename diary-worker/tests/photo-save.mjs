import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readPhotoSaveList } from "../src/photo-save.js";
import { photoSaveMethod, readSaveRecord, savedFileNames, validSaveDate } from "../public/diary-photo-save.js";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const normalizeFilterDate = value => {
  if (!value) return "";
  if (!validSaveDate(value)) throw new HttpError(400, "invalid date");
  return value;
};
const id = number => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, "0")}`;
const db = new DatabaseSync(":memory:");
const migrations = new URL("../migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
function prepare(sql, args = []) {
  return { bind: (...values) => prepare(sql, values), async all() { return { results: db.prepare(sql).all(...args) }; } };
}
const env = { DB: { prepare } }, session = { activeHouseholdId: "tanaka-household" };
function entry(number, date, extra = {}) {
  db.prepare(`INSERT INTO diary_entries(id, entry_date, title, content, household_id, status, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(number, date, extra.title || "日記", extra.content || "本文", extra.household || session.activeHouseholdId, extra.status || "published", extra.deleted || null);
  db.prepare(`INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name)
    VALUES(?,?,?,'image/jpeg',12,?,?,?,'main-admin','fixture')`).run(id(number), number, `IMG_${number}.JPG`, `o${number}`, `d${number}`, `t${number}`);
}
try {
  entry(1, "2026-01-01"); entry(2, "2026-11-30"); entry(3, "2025-12-31"); entry(4, "2026-12-01");
  entry(5, "2026-11-03", { household: "chiharu-household" });
  entry(6, "2026-11-03", { status: "draft" }); entry(7, "2026-11-03", { deleted: "2026-11-03" });
  const url = (from = "2026-01-01", to = "2026-11-30") => new URL(`https://fixture/diary/api/photos/save-list?${new URLSearchParams({ dateFrom: from, dateTo: to })}`);
  const list = await readPhotoSaveList(url(), env, session, { normalizeFilterDate, HttpError });
  assert.deepEqual(list.photos.map(p => p.id), [id(1), id(2)], "inclusive endpoints, ranges over 30 days, published/household/trash isolation");
  assert.deepEqual(Object.keys(list.photos[0]).sort(), ["id", "fileName", "contentType", "originalSize"].sort(), "no diary text, R2 keys or image bytes");
  assert.deepEqual((await readPhotoSaveList(url("2026-02-01", "2026-02-01"), env, session, { normalizeFilterDate, HttpError })).photos, []);
  for (const [from, to] of [["", "2026-11-03"], ["2026-02-30", "2026-11-03"], ["2026-12-01", "2026-11-03"]]) {
    await assert.rejects(readPhotoSaveList(url(from, to), env, session, { normalizeFilterDate, HttpError }), error => error.status === 400);
  }
  // Execute the production album search SQL against the same database.
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function listPhotos(");
  const listPhotos = new Function(`const normalizeSearch=v=>v, clampNumber=(v,min,max,fallback)=>v==null?fallback:Math.min(max,Math.max(min,Number(v))), serializePhoto=v=>v, json=v=>v;
    ${source.slice(start, source.indexOf("\nasync function listPhotoMeta", start))}; return listPhotos;`)();
  const search = query => listPhotos(new URL(`https://fixture/?${new URLSearchParams(query)}`), env, session);
  assert.deepEqual((await search({ entryQuery: "IMG_2.JPG" })).photos.map(p => p.id), [id(2)], "unified input searches file names");
  assert.equal((await search({ entryQuery: "本文" })).photos.length, 4, "body search still works");
  db.prepare("INSERT INTO diary_tags(entry_id,tag,sort_order) VALUES(1,'記念',0)").run();
  assert.deepEqual((await search({ entryQuery: "記念" })).photos.map(p => p.id), [id(1)]);
  assert.deepEqual((await search({ entryQuery: "IMG_2.JPG", month: "2026-01" })).photos, []);
  assert.deepEqual((await search({ fileName: "IMG_1.JPG" })).photos.map(p => p.id), [id(1)], "legacy API filter stays compatible");
} finally { db.close(); }

assert.equal(validSaveDate("2026-99-99"), false);
assert.equal(validSaveDate("2026-02-29"), false);
assert.equal(validSaveDate("2028-02-29"), true);
const now = Date.now();
const record = { version: 1, from: "2026-01-01", to: "2026-11-30", ids: [id(1), id(2)], done: [id(1)], updatedAt: now };
assert.deepEqual(readSaveRecord(JSON.stringify(record), now), record);
for (const patch of [{ ids: [id(1), id(1)] }, { done: [id(3)] }, { done: [id(1), id(1)] }, { ids: ["../secret"] }, { updatedAt: now - 8 * 86400000 }, { updatedAt: now + 1 }, { from: "2026-99-99" }]) {
  assert.equal(readSaveRecord(JSON.stringify({ ...record, ...patch }), now), null);
}
assert.equal(readSaveRecord("invalid"), null);
assert.deepEqual(savedFileNames(["photo.JPG", "photo.JPG", "PHOTO.jpg", "../CON.jpg", "CON.jpg", ""].map(fileName => ({ fileName }))),
  ["photo.JPG", "photo (2).JPG", "PHOTO (3).jpg", ".._CON.jpg", "_CON.jpg", "photo"]);
const longName = savedFileNames([{ fileName: "x".repeat(250) + ".heic" }])[0];
assert.ok(longName.length <= 180 && longName.endsWith(".heic"));
console.log("Album save: date snapshot, access boundaries, unified search, resume validation and safe file names passed.");

// Device classification must not use viewport width or touch alone: Windows
// touch PCs still save folders, Android/iPad desktop mode never do.
const folderBrowser = { showDirectoryPicker() {} };
const sharing = { share() {}, canShare: () => true };
for (const [device, browser, expected] of [
  [{ userAgent: "Windows NT 10.0", maxTouchPoints: 10 }, folderBrowser, "folder"],
  [{ userAgent: "Android", ...sharing }, folderBrowser, "browser"],
  [{ userAgentData: { mobile: true } }, folderBrowser, "browser"],
  [{ userAgent: "iPhone", ...sharing }, folderBrowser, "share"],
  [{ userAgent: "iPhone CriOS", ...sharing }, {}, "share"],
  [{ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5, ...sharing }, folderBrowser, "share"],
  [{ userAgent: "Macintosh Safari", ...sharing }, {}, "browser"],
  [{ userAgent: "iPhone" }, {}, "browser"],
  [{ userAgent: "iPhone", ...sharing, canShare: () => false }, {}, "browser"],
  [{ userAgent: "iPhone", ...sharing, canShare: () => { throw new Error("blocked"); } }, {}, "browser"]
]) assert.equal(photoSaveMethod(browser, device), expected);
console.log("Album save device routing: Windows touch PC, Android, iPhone Safari/Chrome, iPad desktop mode and unsupported APIs passed.");

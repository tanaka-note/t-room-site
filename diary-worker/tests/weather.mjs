import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { WEATHER_LABELS } from "../public/diary-weather.js";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE diary_entries (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO diary_entries (title) VALUES ('旧日記');");
db.exec(await readFile(new URL("../migrations/0018_diary_weather.sql", import.meta.url), "utf8"));
assert.equal(db.prepare("SELECT weather FROM diary_entries").get().weather, null);
for (const weather of Object.keys(WEATHER_LABELS)) {
  db.prepare("UPDATE diary_entries SET weather = ?").run(weather);
  assert.equal(db.prepare("SELECT weather FROM diary_entries").get().weather, weather);
}
assert.throws(() => db.prepare("UPDATE diary_entries SET weather = ?").run("invalid"), /CHECK/);
db.exec("UPDATE diary_entries SET weather = NULL");
assert.equal(db.prepare("SELECT title FROM diary_entries").get().title, "旧日記");
db.close();
const sw = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
assert.match(sw, /\/diary\/diary-weather\.js\?v=diary-/);
console.log("Weather migration: existing rows, all IDs, DB constraint, null and offline asset passed.");

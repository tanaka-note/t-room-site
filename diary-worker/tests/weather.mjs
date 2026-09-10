import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
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
const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const routing = worker.slice(worker.indexOf("async function serveAsset("), worker.indexOf("function isInvestmentAssetPath("));
const context = vm.createContext({ Request, Response, URL, Headers });
vm.runInContext(routing, context);
const url = new URL("https://diary.test/diary/diary-weather.js?v=test");
const response = await context.serveAsset(new Request(url), {
  ASSETS: { fetch: async (request) => {
    assert.equal(new URL(request.url).pathname, "/diary-weather.js");
    return new Response(await readFile(new URL("../public/diary-weather.js", import.meta.url)), { headers: { "content-type": "text/javascript" } });
  } }
}, url, "/diary-weather.js");
assert.equal(response.status, 200);
assert.match(await response.text(), /export const WEATHER_LABELS/);
console.log("Weather migration: existing rows, all IDs, DB constraint, null and offline asset passed.");

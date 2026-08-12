import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all billing accounts use a rolling 30-day session", async () => {
  const [worker, config, migration] = await Promise.all([
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../migrations/0006_change_owner_login_id.sql", import.meta.url), "utf8")
  ]);

  assert.match(worker, /const MAX_SESSION_SECONDS = 30 \* 24 \* 60 \* 60/);
  assert.match(worker, /refreshAuthenticatedSession\(request, response, env, url, path\)/);
  assert.match(worker, /Max-Age=\$\{maxAge\}/);
  assert.match(worker, /const maxAge = sessionMaxAge\(env\)/);
  assert.match(config, /"SESSION_TTL_SECONDS": "2592000"/);
  assert.match(config, /"SESSION_VERSION": "3"/);
  assert.match(migration, /SET login_id = 'contact@a-tanaka\.jp'/);
  assert.match(migration, /WHERE id = 'owner'/);
});

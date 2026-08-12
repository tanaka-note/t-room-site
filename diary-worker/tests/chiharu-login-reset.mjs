import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/0008_chiharu_login_reset.sql", import.meta.url), "utf8");

assert.match(migration, /WHERE id = 'chiharu-admin'/);
assert.match(migration, /login_id = 'giantz3031@gmail\.com'/);
assert.match(migration, /password_hash = NULL/);
assert.match(migration, /must_change_password = 1/);
assert.match(migration, /session_version = session_version \+ 1/);

console.log("Chiharu login ID and temporary-password reset migration: ok");

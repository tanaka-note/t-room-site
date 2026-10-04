import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

export function attachPasskeyLedger(env) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../../security-worker/migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL("../../security-worker/migrations/" + name, import.meta.url), "utf8"));
  const source = readFileSync(new URL("../../security-worker/src/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function cloudPasskeySession(env, input)");
  const end = source.indexOf("\nasync function ", start + 10);
  const context = { Date, Number, String, Math,
    validatePasskeySession: (_env, input) => env.SECURITY.validatePasskeySession(input),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    validSessionStart: value => Number.isFinite(Date.parse(value)) ? value : null };
  vm.runInNewContext(source.slice(start, end) + ";globalThis.ledger=cloudPasskeySession", context);
  const fixtureEnv = { DB: { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } };
  } } };
  env.SECURITY.cloudPasskeySession = input => context.ledger(fixtureEnv, input);
  return db;
}

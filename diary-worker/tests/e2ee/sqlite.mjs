import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function memoryDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../../e2ee/schema.sql", import.meta.url), "utf8"),
  );
  const prepare = (sql) => {
    const bind = (...args) => ({
      first: async () => sqlite.prepare(sql).get(...args) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
      execute: () =>
        /^\s*(SELECT|PRAGMA)/i.test(sql)
          ? { results: sqlite.prepare(sql).all(...args) }
          : { meta: sqlite.prepare(sql).run(...args) },
    });
    return { bind, ...bind() };
  };
  return {
    sqlite,
    prepare,
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => sqlite.close(),
  };
}

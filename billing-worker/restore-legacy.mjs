import initSqlJs from "sql.js";
import { validateSnapshot } from "../backup-worker/src/backup.js";
import { readExportParts, validateExportManifest } from "../backup-worker/src/export-backup.js";
import { verifiedGeneration } from "../backup-worker/src/integrity.js";
import { SERVICES } from "../backup-worker/src/registry.js";
import { assertArchiveSchema } from "../backup-worker/src/schema-guard.js";
import { billingLegacyProfile } from "../backup-worker/src/billing-legacy-profile.js";
import { createLegacyArchive } from "../backup-worker/tools/d1-legacy-archive.mjs";
import migration1 from "./migrations/0001_init.sql";
import migration2 from "./migrations/0002_documents.sql";
import migration3 from "./migrations/0003_add_machiko.sql";
import migration4 from "./migrations/0004_login_limits.sql";
import migration5 from "./migrations/0005_settlements.sql";
import migration6 from "./migrations/0006_change_owner_login_id.sql";
import migration7 from "./migrations/0007_password_security.sql";
import migration8 from "./migrations/0008_password_auth_policy.sql";

const migrations = [migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8];
const tables = SERVICES.billing.tables;

export async function billingLegacyArchive(options = {}) {
  const SQL = await initSqlJs({ locateFile: () => "/security/vendor/sql-wasm.wasm", ...options });
  return createLegacyArchive(billingLegacyProfile, async (bucket, key) => {
    const exported = key.startsWith(billingLegacyProfile.exportPrefix);
    const archive = await verifiedGeneration(bucket, key, payload => (
      exported ? validateExportManifest(payload, "billing") : validateSnapshot(payload, "billing")
    ));
    if (!archive) throw new Error("BillingArchiveGenerationMissing");
    const { payload } = archive;
    if (exported) await assertArchiveSchema("billing", payload.expectedMigration, payload.schema);
    const db = new SQL.Database();
    try {
      db.run("PRAGMA foreign_keys=ON");
      for (const sql of migrations) db.exec(sql);
      db.run("BEGIN");
      db.run("PRAGMA defer_foreign_keys=ON");
      const triggers = db.exec("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")[0]?.values ?? [];
      for (const [name] of triggers) db.run(`DROP TRIGGER "${name}"`);
      for (const { name } of [...tables].reverse()) db.run(`DELETE FROM ${name}`);
      const inserts = new Map();
      try {
        for (const { name, columns } of tables) {
          inserts.set(name, db.prepare(`INSERT INTO ${name} (${columns.join(",")})
            VALUES (${columns.map(() => "?").join(",")}) RETURNING ${columns.join(",")}`));
        }
        const parts = exported ? readExportParts(bucket, payload, "billing")
          : tables.map(({ name }) => ({ table: name, rows: payload.tables[name].rows }));
        for await (const { table, rows } of parts) {
          const { columns } = tables.find(({ name }) => name === table);
          for (const row of rows) {
            const values = columns.map(column => row[column]);
            if (values.some(value => value !== null && typeof value !== "string"
              && (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))) {
              throw new Error("BillingArchiveInvalidCell");
            }
            const insert = inserts.get(table);
            insert.bind(values);
            if (!insert.step() || insert.get().some((value, index) => value !== values[index])) {
              throw new Error("BillingArchiveRestoreMismatch");
            }
            insert.reset();
          }
        }
      } finally {
        for (const insert of inserts.values()) insert.free();
      }
      for (const { name } of tables) {
        if (db.exec(`SELECT COUNT(*) FROM ${name}`)[0].values[0][0] !== payload.tables[name].rowCount) {
          throw new Error("BillingArchiveRestoreMismatch");
        }
      }
      db.run("UPDATE billing_accounts SET is_active=0,session_version=session_version+1");
      for (const [, sql] of triggers) db.run(sql);
      if (db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] !== "ok" || db.exec("PRAGMA foreign_key_check").length) {
        throw new Error("BillingArchiveRestoreMismatch");
      }
      db.run("COMMIT");
      return { payload, db: {
        prepare(sql) {
          return { get() {
            const statement = db.prepare(sql);
            try { return statement.step() ? statement.getAsObject() : undefined; }
            finally { statement.free(); }
          } };
        },
        close: () => db.close()
      } };
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function database(service) {
  const db = new DatabaseSync(':memory:');
  const directory = new URL(`../../${service}-worker/migrations/`, import.meta.url);
  for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  return db;
}
export function d1(db) {
  const prepare = (sql, values = []) => ({
    sql, values, bind: (...v) => prepare(sql, v),
    async all() { return { results: db.prepare(sql).all(...values), success: true }; },
    async first() { return db.prepare(sql).get(...values) || null; },
    async run() { return { success: true, meta: db.prepare(sql).run(...values) }; }
  });
  return { prepare, async batch(items) {
    db.exec('BEGIN');
    try {
      const result = [];
      for (const item of items) result.push(/^\s*(SELECT|WITH)\b|\bRETURNING\b/.test(item.sql) ? await item.all() : await item.run());
      db.exec('COMMIT'); return result;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
}
export class Bucket {
  objects = new Map(); writes = []; failPut = false; corrupt = false;
  async put(key, value, options = {}) {
    if (this.failPut) throw new Error('sensitive payload must never enter logs');
    const prior = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    if (options.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, ...options, etag: crypto.randomUUID(), uploaded: new Date() }); this.writes.push(key);
    return this.objects.get(key);
  }
  async get(key, options = {}) {
    const value = this.objects.get(key); if (!value) return null;
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== value.etag) return { etag: value.etag };
    const bytes = this.corrupt ? new Uint8Array([0]) : value.bytes;
    return { ...value, body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.buffer, size: bytes.length };
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    const offset = Number(cursor || 0), selected = all.slice(offset, offset + limit);
    return { objects: selected.map(([key, value]) => ({ ...value, key, size: value.bytes.length })),
      truncated: offset + selected.length < all.length, cursor: String(offset + selected.length) };
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async head(key) { return this.get(key); }
}
export function recorder() {
  const events = [];
  return { events, SECURITY: { async recordAuditEvent(event) { events.push(event); return { stored: true }; } } };
}

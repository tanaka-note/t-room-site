import assert from 'node:assert/strict';
import { exportSpec } from '../src/export-backup.js';

export const exportEnv = (service, db, bucket) => ({
  [exportSpec(service).binding]: db, [service === 'diary' ? 'DIARY_BACKUP' : 'BACKUP']: bucket,
  D1_EXPORT_ACCOUNT_ID: '0'.repeat(32), D1_EXPORT_API_TOKEN: crypto.randomUUID()
});
export function sqlDump(db, service) {
  const literal = value => value === null ? 'NULL' : typeof value === 'string' ? "'" + value.replaceAll("'", "''").replaceAll('\0', "'||char(0)||'") + "'" : String(value);
  return 'PRAGMA defer_foreign_keys=TRUE;\n' + exportSpec(service).tables.flatMap(t => {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${t.name}') ORDER BY cid`).all().map(r => r.name);
    return db.prepare(`SELECT * FROM ${t.name}`).all().map(row => `INSERT INTO "${t.name}" VALUES(${columns.map(c => literal(row[c])).join(',')});\n`);
  }).join('');
}
export function sqlStream(sql, size = 8192) {
  const bytes = new TextEncoder().encode(sql); let position = 0;
  return new ReadableStream({ pull(controller) {
    if (position === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(position, position + size)); position += Math.min(size, bytes.length - position);
  } });
}
export function exportFetcher(source, service, { sql, size, onStart = () => {} } = {}) {
  const calls = []; let captured;
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).startsWith('https://api.cloudflare.com/')) {
      assert.equal(options.method, 'POST'); assert.ok(options.headers.Authorization);
      const body = JSON.parse(options.body);
      if (!body.current_bookmark) {
        assert.equal(body.dump_options.no_schema, true);
        assert.deepEqual(body.dump_options.tables, exportSpec(service).tables.map(t => t.name));
        captured = sql ?? sqlDump(source, service); onStart();
        return Response.json({ success: true, result: { status: 'active', at_bookmark: 'fixture-bookmark' } });
      }
      return Response.json({ success: true, result: { status: 'complete', at_bookmark: 'fixture-bookmark', result: { signed_url: 'https://fixture.r2.cloudflarestorage.com/export?signature=fixture-only' } } });
    }
    assert.equal(options.headers, undefined, 'the export API token must never be sent to the download origin');
    return new Response(sqlStream(captured, size));
  };
  return { fetcher, calls };
}

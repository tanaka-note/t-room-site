// Bounds apply inside SQLite, before any row set crosses into the Worker heap.
export const SNAPSHOT_ROWS = 10000;
export const SNAPSHOT_DATA_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_JSON_BYTES = 16 * 1024 * 1024;
const ROW_BYTES = 1024 * 1024;

// Hosted D1 accepts at most five terms per compound SELECT. Group branches
// inside the same statement, preserving one snapshot and one global guard.
export function unionAll(statements) {
  if (statements.length <= 5) return statements.join(' UNION ALL ');
  const groups = [];
  for (let i = 0; i < statements.length; i += 5) {
    groups.push(`SELECT * FROM (${unionAll(statements.slice(i, i + 5))})`);
  }
  return unionAll(groups);
}

function rowJson(columns) {
  const groups = [];
  for (let i = 0; i < columns.length; i += 16) {
    groups.push(`json_object(${columns.slice(i, i + 16).flatMap(c => [`'${c}'`, c]).join(',')})`);
  }
  // json_patch would drop NULL-valued columns; join complete JSON members instead.
  return groups.length === 1 ? groups[0] : `json(${groups.map((g, i) => i === 0 ? `substr(${g},1,length(${g})-1)` : i === groups.length - 1 ? `substr(${g},2)` : `substr(${g},2,length(${g})-2)`).join(" || ',' || ")})`;
}
export function snapshotStatement(db, tables, { rows = SNAPSHOT_ROWS, bytes = SNAPSHOT_DATA_BYTES, params = [] } = {}) {
  const sizes = unionAll(tables.map(t => {
    const unsafe = t.columns.map(c => `(typeof(${c})='integer' AND (${c}>9007199254740991 OR ${c} < -9007199254740991))`).join(' OR ');
    return `SELECT count(*) AS n, coalesce(sum(length(CAST(${rowJson(t.columns)} AS BLOB))),0) AS b,
      coalesce(max(length(CAST(${rowJson(t.columns)} AS BLOB))),0) AS largest,
      coalesce(max(CASE WHEN ${unsafe} THEN 1 ELSE 0 END),0) AS unsafe FROM (SELECT ${t.columns.join(',')} FROM ${t.source || t.name} LIMIT ${rows + 1})`;
  }));
  // One SQLite statement/snapshot, but separate result rows: D1's 2 MiB row
  // limit must not be exceeded by aggregating the entire database into one cell.
  const records = tables.map(t => `SELECT '${t.name}' AS tableName, ${rowJson(t.columns)} AS rowJson, NULL AS columnsJson, NULL AS rowCount, NULL AS estimatedBytes, NULL AS unsafeInteger, NULL AS allowed FROM ${t.source || t.name} WHERE (SELECT allowed FROM stats)=1`);
  const columns = tables.map(t => `SELECT '${t.name}',NULL,'${JSON.stringify(t.columns)}',0,NULL,NULL,NULL`);
  return db.prepare(`WITH sizes AS MATERIALIZED (${sizes}), stats AS MATERIALIZED (
    SELECT sum(n) AS rowCount,sum(b) AS estimatedBytes,max(unsafe) AS unsafeInteger,
    (sum(n)<=?${params.length + 1} AND sum(b)<=?${params.length + 2} AND max(largest)<=${ROW_BYTES} AND max(unsafe)=0) AS allowed FROM sizes)
    ${unionAll(['SELECT NULL AS tableName,NULL AS rowJson,NULL AS columnsJson,rowCount,estimatedBytes,unsafeInteger,allowed FROM stats', ...columns, ...records])}`)
    .bind(...params, rows, bytes);
}
export function snapshotTables(result) {
  const row = result?.results?.[0];
  if (result?.success === false || !row) throw new Error('CaptureFailed');
  if (row.unsafeInteger) throw new Error('UnsafeInteger');
  if (!row.allowed) throw new Error('SnapshotTooLarge');
  const tables = {};
  for (const r of result.results.slice(1)) {
    if (r.columnsJson) tables[r.tableName] = { columns: JSON.parse(r.columnsJson), rowCount: 0, rows: [] };
    else { tables[r.tableName].rows.push(JSON.parse(r.rowJson)); tables[r.tableName].rowCount++; }
  }
  return tables;
}

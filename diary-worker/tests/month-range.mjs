// Compare generated production SQL with the former predicate in local SQLite only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function readEntries(');
const fn = source.slice(start, source.indexOf('\nasync function getEntry', start));
const readEntries = new Function(`
  const clampNumber = (v, min, max, fallback) => v === null ? fallback : Math.min(max, Math.max(min, Number(v)));
  const splitSearchTerms = () => [], normalizeFilterDate = v => v || '', normalizeTag = v => v;
  const validateDateRange = (from, to) => ({ from, to }), trashScopeAccess = () => null;
  const appendEntryKeywordConditions = () => {}, serializeEntry = row => row;
  ${fn}
  return readEntries;`)();
const db = new DatabaseSync(':memory:');
const migrations = new URL('../migrations/', import.meta.url);
for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(name, migrations), 'utf8'));
}
const dates = ['2025-12-31', '2026-01-01', '2026-09-30', '2026-10-01', '2026-10-31',
  '2026-11-01', '2026-12-31', '2027-01-01', '9999-12-31',
  '2026-10', '2026-10-00', '2026-10-99', '2026-10\uffff', '2026-19-01'];
for (const [i, date] of dates.entries()) {
  db.prepare(`INSERT INTO diary_entries(id, entry_date, title, content, household_id, last_published_at)
    VALUES (?, ?, 'fixture', 'fixture', 'tanaka-household', '2026-10-01T01:00:00Z')`).run(i + 1, date);
}
db.exec(`INSERT INTO diary_entries(id, entry_date, title, content, household_id) VALUES
  (100, '2026-10-01', 'other', 'fixture', 'chiharu-household'),
  (101, '2026-10-01', 'draft', 'fixture', 'tanaka-household');
  UPDATE diary_entries SET status='draft' WHERE id=101;`);
let query;
const env = { DB: { prepare(sql) { return { bind(...args) { return { async all() {
  query = { sql, args }; return { results: db.prepare(sql).all(...args) };
} }; } }; } } };
try {
  for (const month of ['2026-01', '2026-09', '2026-10', '2026-12', '2026-19', '2026-00', '9999-12']) {
    for (const offset of [0, 1, 4]) {
      const result = await readEntries(new URL(`https://fixture.test/?month=${month}&limit=2&offset=${offset}`), env,
        { accountId: 'reader', activeHouseholdId: 'tanaka-household' });
      const old = db.prepare(`SELECT id FROM diary_entries e WHERE e.household_id=? AND e.deleted_at IS NULL
        AND e.status='published' AND substr(e.entry_date,1,7)=?
        ORDER BY e.entry_date DESC, e.last_published_at DESC, e.id DESC LIMIT 3 OFFSET ?`)
        .all('tanaka-household', month, offset);
      assert.deepEqual(result.entries.map(e => e.id), old.slice(0, 2).map(e => e.id));
      assert.equal(result.hasMore, old.length > 2);
    }
  }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args);
  assert.ok(plan.some(row => /idx_diary_entries_household_published_at.*entry_date>\? AND entry_date<\?/.test(row.detail)));
  console.log('Month range matches legacy predicate, order, pagination and isolation; existing date index bounds the scan.');
} finally { db.close(); }

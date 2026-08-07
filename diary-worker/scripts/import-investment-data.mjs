import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const COLUMN_KEYS = {
  "合計（円）": "total",
  "預金・現金（円）": "cash",
  "株式(現物)（円）": "stocks",
  "投資信託（円）": "funds",
  "債券（円）": "bonds",
  "暗号資産（円）": "crypto",
  "先物OP（円）": "futures",
  "ポイント（円）": "points",
  "その他の資産（円）": "other"
};
const MIN_INCLUDED_DATE = "2022-07-01";

const args = parseArgs(process.argv.slice(2));
if (!args.monthly || !args.dailyDir || !/^\d{4}-\d{2}-\d{2}$/.test(args.through || "")) {
  fail("--monthly、--daily-dir、--through YYYY-MM-DD を指定してください。");
}
if (args.local && args.remote) fail("--local と --remote は同時に指定できません。");

const records = new Map();
await loadCsv(args.monthly, records, 1);
const dailyFiles = (await readdir(args.dailyDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
  .sort((a, b) => a.name.localeCompare(b.name, "ja"));
for (const entry of dailyFiles) {
  await loadCsv(path.join(args.dailyDir, entry.name), records, 2);
}

const selected = [...records.values()]
  .filter((record) => record.date >= MIN_INCLUDED_DATE && record.date <= args.through)
  .sort((a, b) => a.date.localeCompare(b.date));
if (!selected.length) fail("指定期間に取り込めるデータがありません。");

const first = selected[0];
const last = selected.at(-1);
console.log(`records=${selected.length}`);
console.log(`period=${first.date}..${last.date}`);
console.log(`latest_total=${last.total}`);

if (!args.local && !args.remote) {
  console.log("dry-run: D1は変更していません。--local または --remote を指定すると取り込みます。");
  process.exit(0);
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "troom-investment-"));
const sqlPath = path.join(temporaryDirectory, "investment-history.sql");
try {
  await writeFile(sqlPath, buildSql(selected), "utf8");
  const wrangler = path.resolve("node_modules/wrangler/bin/wrangler.js");
  const target = args.remote ? "--remote" : "--local";
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "diary-db", target, "--file", sqlPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) process.exit(result.status || 1);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function loadCsv(filePath, target, priority) {
  const bytes = await readFile(filePath);
  const text = new TextDecoder("shift_jis").decode(bytes).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return;
  const headers = parseCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const source = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const date = normalizeDate(source["日付"]);
    if (!date) fail(`日付を読み取れません: ${filePath}`);
    const record = {
      date,
      total: 0,
      cash: 0,
      stocks: 0,
      funds: 0,
      bonds: 0,
      crypto: 0,
      futures: 0,
      points: 0,
      other: 0,
      priority
    };
    for (const [header, key] of Object.entries(COLUMN_KEYS)) {
      record[key] = parseAmount(source[header] || "0", filePath, date);
    }
    const componentTotal = record.cash + record.stocks + record.funds + record.bonds
      + record.crypto + record.futures + record.points + record.other;
    if (componentTotal !== record.total) {
      fail(`合計と内訳が一致しません: ${filePath} ${date}`);
    }
    const existing = target.get(date);
    if (!existing || priority >= existing.priority) target.set(date, record);
  }
}

function buildSql(recordsToWrite) {
  const statements = [
    `DELETE FROM investment_history WHERE recorded_at < '${MIN_INCLUDED_DATE}';`
  ];
  for (let index = 0; index < recordsToWrite.length; index += 100) {
    const chunk = recordsToWrite.slice(index, index + 100);
    const values = chunk.map((record) => `('${record.date}',${record.total},${record.cash},${record.stocks},${record.funds},${record.bonds},${record.crypto},${record.futures},${record.points},${record.other},CURRENT_TIMESTAMP)`).join(",\n");
    statements.push(`INSERT INTO investment_history
      (recorded_at,total,cash,stocks,funds,bonds,crypto,futures,points,other,updated_at)
      VALUES
      ${values}
      ON CONFLICT(recorded_at) DO UPDATE SET
        total=excluded.total,
        cash=excluded.cash,
        stocks=excluded.stocks,
        funds=excluded.funds,
        bonds=excluded.bonds,
        crypto=excluded.crypto,
        futures=excluded.futures,
        points=excluded.points,
        other=excluded.other,
        updated_at=CURRENT_TIMESTAMP;`);
  }
  return `${statements.join("\n\n")}\n`;
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

function normalizeDate(value) {
  const match = String(value || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseAmount(value, filePath, date) {
  const normalized = String(value || "0").replaceAll(",", "").trim();
  if (!/^-?\d+$/.test(normalized)) fail(`金額を読み取れません: ${filePath} ${date}`);
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount) || amount < 0) fail(`金額が不正です: ${filePath} ${date}`);
  return amount;
}

function parseArgs(values) {
  const parsed = { local: false, remote: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--local") parsed.local = true;
    else if (value === "--remote") parsed.remote = true;
    else if (value === "--monthly") parsed.monthly = values[++index];
    else if (value === "--daily-dir") parsed.dailyDir = values[++index];
    else if (value === "--through") parsed.through = values[++index];
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

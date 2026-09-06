import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const parentBrandPages = [
  "index.html",
  "apps.html",
  "articles.html",
  "game.html",
  "diary.html",
  "diary/archive.html",
  "diary/tags.html",
  "investment.html",
  "investment-performance.html",
  "investment-bitcoin-decline.html",
  "investment-boj-rate-hike.html",
  "investment-btc-four-year-cycle.html",
  "learning.html",
  "learning/index.html",
  "learning/sharoushi/index.html",
  "learning/sharoushi/logs/index.html",
  "learning/sharoushi/logs/template.html",
  ...Array.from({ length: 11 }, (_, index) => `learning/sharoushi/logs/${String(index + 1).padStart(3, "0")}.html`),
  "learning/sharoushi/subjects/index.html",
  "learning/sharoushi/topics/index.html",
  "life.html",
  "thought.html",
  "work.html",
  "columns/current-affairs/001.html",
  "columns/current-affairs/index.html",
  "columns/music/001.html",
  "columns/music/002.html",
  "columns/music/index.html",
  "transfer/index.html",
];

for (const relativePath of parentBrandPages) {
  const source = await read(relativePath);
  assert.match(source, /T-lain/, `${relativePath}: T-lain の表示が必要です`);
  assert.doesNotMatch(
    source,
    /(?:aria-label="T-ROOM ホームへ"|og:site_name" content="T-ROOM"|&copy; 2026 T-ROOM|\| T-ROOM(?: \| 知の庭)?)/,
    `${relativePath}: 旧親ブランド表記が残っています`,
  );
}

const home = await read("index.html");
assert.match(home, /<title>T-lain \| 記憶と記録のプラットフォーム<\/title>/);
assert.match(home, /<meta property="og:site_name" content="T-lain">/);
assert.match(home, /記憶と記録のプラットフォーム/);

const security = await read("security-worker/public/index.html");
assert.match(security, /<title>T-lain セキュリティセンター<\/title>/);
assert.match(security, /<p class="eyebrow">T-lain<\/p>/);

const cloud = await read("cloud-worker/public/index.html");
assert.match(cloud, /aria-label="T-lainトップへ"/);
assert.match(cloud, /<div class="service-name">Cloud Storage<\/div>/);
assert.match(await read("cloud-worker/public/manifest.webmanifest"), /"name": "T-Cloud Storage"/);

assert.match(await read("billing-worker/public/index.html"), /T-lain PRIVATE/);
assert.match(await read("diary-worker/public/index.html"), /T-lain管理者/);
assert.match(await read("tools/learning-visuals/render_learning_visuals.py"), /"T-lain"/);
assert.match(await read("tools/learning-visuals/render_004.py"), /"T-lain"/);

// Derived app brands migrate too; fictional worlds and compatibility values do not.
assert.match(await read("game.html"), /知の庭をぴょんぴょん進む/);
assert.match(await read("game.html"), /T-lain OniTaiji/);
for (const [file, name] of [
  ["oni-type.html", "T-lain OniTaiji"],
  ["oni-type-en.html", "T-lain OniTaiji English"],
  ["blocks-game.html", "T-lain BLOCKS"],
  ["blocks-game.js", "T-lain BLOCKS"],
  ["hop-game.html", "T-lain Garden Hop"],
  ["hop-game.js", "T-lain Garden Hop"],
  ["stone-stack.html", "T-lain Stone"],
]) assert((await read(file)).includes(name), `${file}: ${name} is required`);
for (const file of ["hop-game.html", "hop-game.js"]) {
  const source = await read(file);
  assert(source.includes("知の庭") && source.includes("知の芽"), `${file}: preserve the game world`);
}

const registry = JSON.parse(await read("web-apps.json"));
for (const app of registry.apps) {
  assert(!app.name.includes("T-ROOM"), `${app.id}: old registry display name`);
  for (const file of [...app.entrypoints, ...(app.manifest ? [app.manifest] : [])]) {
    assert(!(await read(file)).includes("T-ROOM"), `${file}: old user-facing brand`);
  }
}
assert.equal(registry.apps.find((app) => app.id === "cloud").name, "T-Cloud Web");
assert.equal(registry.apps.find((app) => app.id === "site").name, "T-lain本体・公開ページ");
assert.equal(registry.apps.find((app) => app.id === "security").name, "T-lain Security Center");
for (const [file, name] of [
  ["apps/calculator/manifest.webmanifest", "T-lain 電卓"],
  ["calculator-install.webmanifest", "T-lain 電卓"],
  ["apps/kokoro-tenbin/manifest.webmanifest", "T-lain 心の天秤"],
  ["apps/motivation-switch/manifest.webmanifest", "T-lain Swich"],
  ["apps/omikuji/manifest.webmanifest", "T-lain おみくじ"],
  ["apps/ima-camera/manifest.webmanifest", "今を撮る"],
]) assert.equal(JSON.parse(await read(file)).name, name);
assert.match(await read("apps/calculator/index.html"), /<p class="display-brand">T-lain<\/p>/);
assert.match(await read("android-ai-chat/app/src/main/res/values/strings.xml"), /AI Chat By T-lain/);
assert.match(await read("android-ai-chat/app/src/main/java/jp/tanaka/troom/ai/ui/AiChatApp.kt"), /Text\("By T-lain"/);
assert.match(await read("android-ai-chat/app/build.gradle.kts"), /applicationId = "jp\.tanaka\.troom\.ai"/);
assert.match(await read("android-ai-chat/app/src/main/java/jp/tanaka/troom/ai/data/AiHttpClient.kt"), /AI-Chat-By-T-ROOM-Android\/0\.1\.0/);
assert.match(await read("security-worker/wrangler.jsonc"), /"RP_NAME": "T-ROOM"/);
assert.match(await read("cloud-worker/public/crypto-vault.js"), /T-ROOM Cloud Storage/);

// Historical migrations are immutable. Follow-up migrations touch only exact
// built-in labels, not user content, roles, session state, or encrypted data.
const aiMigration = await read("ai-worker/migrations/0003_tlain_brand.sql");
const labelMigration = await read("security-worker/migrations/0013_tlain_ai_display_label.sql");
const oldPersona = "あなたはT-ROOMのAIキャラクター「ずんだもん」です。事実と推測を区別し、安全で役に立つ回答を日本語で行ってください。知らないことは断定しません。";
const db = new DatabaseSync(":memory:");
try {
  db.exec(await read("ai-worker/migrations/0001_ai_chat_foundation.sql"));
  db.exec(aiMigration);
  assert.equal(db.prepare("SELECT persona_instructions FROM ai_characters WHERE id = 'zundamon'").get().persona_instructions, oldPersona.replace("T-ROOM", "T-lain"));
  const custom = "利用者がカスタマイズした指示";
  db.prepare("UPDATE ai_characters SET persona_instructions = ? WHERE id = 'zundamon'").run(custom);
  db.exec(aiMigration);
  assert.equal(db.prepare("SELECT persona_instructions FROM ai_characters WHERE id = 'zundamon'").get().persona_instructions, custom);

  db.exec("CREATE TABLE security_service_links (id TEXT PRIMARY KEY, service TEXT, service_account_id TEXT, display_label TEXT, status TEXT, encrypted_payload TEXT)");
  const insert = db.prepare("INSERT INTO security_service_links VALUES (?, ?, ?, ?, ?, ?)");
  for (const status of ["active", "pending", "disabled"]) insert.run(status, "ai", "owner", "AI Chat By T-ROOM", status, "unchanged ciphertext");
  insert.run("custom", "ai", "owner", "利用者の表示名", "active", "unchanged ciphertext");
  insert.run("other-service", "cloud", "admin", "AI Chat By T-ROOM", "active", "unchanged ciphertext");
  insert.run("other-account", "ai", "custom", "AI Chat By T-ROOM", "active", "unchanged ciphertext");
  const before = db.prepare("SELECT * FROM security_service_links ORDER BY id").all();
  db.exec(labelMigration);
  db.exec(labelMigration);
  const after = db.prepare("SELECT * FROM security_service_links ORDER BY id").all();
  assert.deepEqual(after.map((row) => ({ ...row })), before.map((row) => ({
    ...row,
    display_label: row.service === "ai" && row.service_account_id === "owner" && row.display_label === "AI Chat By T-ROOM" ? "AI Chat By T-lain" : row.display_label,
  })));
} finally { db.close(); }

// Audit every tracked/new text file, not just selected HTML pages. Keep narrow
// exceptions for compatibility, migration history, and internal test diagnostics.
const allowed = {
  "cloud-worker/public/crypto-vault.js": /const \w+_CONTEXT = "T-ROOM Cloud Storage [^"]+";/,
  "cloud-worker/src/index.js": /const context = "T-ROOM Cloud Storage account key v1\|tanaka-note\.com\|";/,
  "android-tcloud/app/src/main/java/jp/tanaka/tcloud/crypto/TCloudCrypto.kt": /private const val \w+_CONTEXT = "T-ROOM Cloud Storage [^"]+"/,
  "cloud-worker/tests/crypto-roundtrip.mjs": /T-ROOM Cloud Storage account key v1\|tanaka-note\.com\|test@example\.com/,
  "android-tcloud/app/src/test/java/jp/tanaka/tcloud/crypto/TCloudCryptoCompatibilityTest.kt": /T-ROOM Cloud Storage account key v1\|tanaka-note\.com\|\$legacyLoginId/,
  "security-worker/wrangler.jsonc": /"RP_NAME": "T-ROOM"/,
  "security-worker/src/index.js": /rpName: env\.RP_NAME \|\| "T-ROOM",/,
  "security-worker/test/security-csp.browser.mjs": /rp: \{ id: "127\.0\.0\.1", name: "T-ROOM" \}/,
  "android-ai-chat/app/src/main/java/jp/tanaka/troom/ai/data/AiHttpClient.kt": /setRequestProperty\("User-Agent", "AI-Chat-By-T-ROOM-Android\/0\.1\.0"\)/,
  "android-ai-chat/app/build.gradle.kts": /^\/\/ 新しい鍵は作らず、既存T-ROOM release署名設定/,
  "ai-worker/migrations/0001_ai_chat_foundation.sql": /'あなたはT-ROOMのAIキャラクター「ずんだもん」です。/,
  "ai-worker/migrations/0003_tlain_brand.sql": /AND persona_instructions = 'あなたはT-ROOMのAIキャラクター「ずんだもん」です。/,
  "security-worker/migrations/0009_ai_chat_service_and_budgets.sql": /SELECT lower\(hex\(randomblob\(16\)\)\), identity\.id, 'ai', 'owner', NULL, 'AI Chat By T-ROOM',/,
  "security-worker/migrations/0013_tlain_ai_display_label.sql": /AND display_label = 'AI Chat By T-ROOM';/,
  "security-worker/test/downloader-migration.test.js": /\('link-ai', 'primary-admin', 'ai', 'owner', NULL, 'AI Chat By T-ROOM', 'active'\)/,
  "billing-worker/test/month-wheel.test.js": /test\("invoice month field keeps the bottom wheel and uses the shared T-ROOM calendar",/,
  "cloud-worker/tests/share-isolation.mjs": /throw new Error\("共有ページにT-ROOM/,
  "tools/sync-troom-date-picker.mjs": /process.stdout.write\("Synchronized the shared T-ROOM date picker assets\./,
  "tools/test-troom-date-picker.mjs": /process.stdout.write\("Shared T-ROOM date picker parity and date arithmetic tests passed\./,
};
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
let remaining = 0;
for (const file of files) {
  if (file === "tools/test-brand-naming.mjs") continue; // policy patterns and legacy fixtures above
  const buffer = await readFile(path.join(root, file));
  if (buffer.includes(0)) continue;
  for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.includes("T-ROOM")) continue;
    assert(allowed[file]?.test(line), `${file}:${index + 1}: unclassified old brand: ${line.trim()}`);
    remaining++;
  }
}
console.log(`brand naming tests: user-facing brands, migration safety, and ${files.length} files checked; ${remaining} classified legacy lines retained`);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

// 個別アプリ・作品世界・互換性に関わる技術名は親ブランド変更の対象外。
assert.match(await read("game.html"), /知の庭をぴょんぴょん進む/);
assert.match(await read("game.html"), /T-ROOM OniTaiji/);
assert.match(await read("apps/calculator/index.html"), /T-ROOM/);
assert.match(await read("android-ai-chat/app/src/main/res/values/strings.xml"), /AI Chat By T-ROOM/);
assert.match(await read("security-worker/wrangler.jsonc"), /"RP_NAME": "T-ROOM"/);
assert.match(await read("cloud-worker/public/crypto-vault.js"), /T-ROOM Cloud Storage/);

console.log(`brand naming tests: ${parentBrandPages.length + 12} checks passed`);

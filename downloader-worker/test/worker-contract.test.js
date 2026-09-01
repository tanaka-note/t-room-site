import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/downloader.js", import.meta.url), "utf8");
const resolver = await readFile(new URL("../container/resolver.py", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/0001_downloader_foundation.sql", import.meta.url), "utf8");

test("二段階解析と明示的な権利確認を分離する", () => {
  assert.match(worker, /\/api\/analyze/);
  assert.match(worker, /rightsConfirmed !== true/);
  assert.match(worker, /status = 'analyzed'/);
  assert.match(worker, /status = 'queued'/);
  assert.match(client, /分析|解析/);
  assert.match(html, /保存する権利があります/);
});

test("URL全文をD1と監査へ保存しない", () => {
  assert.doesNotMatch(migration, /source_url|full_url|query_string/i);
  assert.match(migration, /url_hash/);
  assert.match(worker, /sourceCiphertext/);
  assert.doesNotMatch(worker, /details[^\n]*sourceUrl/);
});

test("Private R2・Queue・Container・Securityを独立bindingにする", () => {
  assert.equal(config.r2_buckets[0].bucket_name, "t-room-downloader-temp");
  assert.equal(config.queues.producers[0].queue, "t-room-downloader-jobs");
  assert.equal(config.services[0].service, "t-room-security");
  assert.equal(config.containers[0].class_name, "DownloaderContainer");
  assert.equal(config.assets.run_worker_first, true);
});

test("未公開ページを検索・共有対象から除外する", () => {
  assert.match(html, /noindex,nofollow,noarchive,nosnippet,noimageindex/);
  assert.doesNotMatch(html, /property=["']og:/i);
  assert.match(worker, /X-Robots-Tag/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test("YouTubeは解析と本体取得を分離して規約上拒否する", () => {
  assert.match(worker, /isPolicyRestrictedHost/);
  assert.match(worker, /isPolicyRestrictedAnalysis\(analysis\)/);
  assert.match(worker, /isPolicyRestrictedAnalysis\(parseJson\(row\.analysis_json/);
  assert.match(worker, /status: 451|new HttpError\(451/);
  assert.match(worker, /YouTubeの利用規約/);
  assert.match(resolver, /policy_restricted[\s\S]*item\["downloadable"\] = False/);
});

test("ユーザー分離と一回限りhandoffを既存Security境界へ委譲する", () => {
  assert.match(worker, /redeemHandoff\(String\(body\.handoffToken \|\| ""\), "downloader"\)/);
  assert.match(worker, /validatePasskeySession/);
  assert.match(worker, /WHERE identity_id = \?/);
  assert.doesNotMatch(worker, /password_login|login_password/);
});

test("R2確定後に30分削除をQueueへ予約しCronも補完する", () => {
  assert.match(worker, /delaySeconds/);
  assert.match(worker, /DOWNLOAD_TTL_SECONDS/);
  assert.match(worker, /cleanupExpiredJobs/);
  assert.match(worker, /env\.DOWNLOADS\.delete/);
  assert.match(worker, /processing_token = \?/);
  assert.match(worker, /processing_lease_expires_at/);
  assert.match(worker, /cleanupOrphanObjects/);
  assert.match(worker, /row\.status === "queued"[\s\S]*env\.JOBS\.send/, "Queue送信失敗・応答消失後は同じjobを安全に再配送できる");
  assert.match(worker, /normalization_mode = \?/);
});

test("外部ツールはshellを介さず固定argvと制限protocolで実行する", async () => {
  const pipeline = await readFile(new URL("../container/media_pipeline.py", import.meta.url), "utf8");
  for (const source of [resolver, pipeline]) {
    assert.match(source, /subprocess\.run\(\s*(?:command|\[)/);
    assert.doesNotMatch(source, /shell\s*=\s*True|(?:sh|bash)\s+-c/);
  }
  assert.match(resolver, /ffmpeg_i:-protocol_whitelist http,https,tcp,tls/);
  assert.match(pipeline, /"-protocol_whitelist", "file,pipe"/);
});

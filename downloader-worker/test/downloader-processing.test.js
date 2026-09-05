import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import * as domain from "../src/downloader-domain.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const processSource = source.slice(source.indexOf("async function processDownloadMessage("), source.indexOf("function normalizeContainerMetrics("));
const healthSource = source.slice(source.indexOf("async function requireHealthyContainer("), source.indexOf("function safeThumbnail("));

test("content rejection is committed once; redelivery does not restart the container", async () => {
  for (const code of ["scan_malware_detected", "scan_yara_detected", "scan_extension_mismatch", "scan_invalid_media_stream", "scan_size_limit", "scan_ffprobe_failed", "scan_ffprobe_invalid", "scan_ffprobe_timeout"]) {
    const row = { status: "queued", url_hash: "hash", analysis_json: "{}" };
    let fetched = 0, released = 0, marked = 0;
    const context = {
      ...domain, Request, AbortSignal, console, Date, crypto: { randomUUID: () => "lease" },
      CONTAINER_HEALTH_TIMEOUT_MS: 90000, QUEUE_FINALIZATION_RESERVE_MS: 60000, CONTAINER_RESPONSE_GRACE_MS: 20000,
      ensureContainerConfigured() {}, parseJson: JSON.parse, clampNumber: () => 720, nowSeconds: () => 100,
      auditSystem: async () => {}, downloadTtl: () => 43200, maxBytesForRow: () => 1024,
      decryptPrivatePayload: async () => ({ sourceHash: "hash", jobId: "job", mediaId: "media", route: { url: "https://example.com/a.mp4" } }),
      createInternalGrant: async () => "grant", requireHealthyContainer: async () => {}, configureContainerEgress: async () => {},
      getContainer: () => ({ fetch: async () => { fetched++; return Response.json({ errorCode: code }, { status: 422 }); } }),
      releaseContainer: async () => { released++; },
      containerResponseError: (code) => Object.assign(new Error(code), { code }),
      markDownloadFailed: async (_env, _message, error, token) => {
        assert.equal(error.code, code); assert.equal(token, "lease"); marked++; row.status = "failed";
      }
    };
    vm.runInNewContext(processSource + ";this.run = processDownloadMessage;", context);
    const env = { DB: { prepare: () => ({ bind() { return this; }, first: async () => row, run: async () => ({ meta: { changes: 1 } }) }) } };
    const message = { jobId: "job", identityId: "owner", mediaId: "media" };
    if (domain.isPermanentDownloadError({ code })) {
      await context.run(env, message);
      await context.run(env, message);
      assert.deepEqual([fetched, released, marked], [1, 1, 1]);
    } else {
      await assert.rejects(context.run(env, message), error => error.code === code);
      await assert.rejects(context.run(env, message), error => error.code === code);
      assert.deepEqual([fetched, released, marked], [2, 2, 0]);
    }
  }
});

test("engine/network/definition/timeouts and unknown errors retain bounded retries", () => {
  for (const code of ["scan_ffprobe_failed", "scan_ffprobe_invalid", "scan_ffprobe_timeout", "scan_malware_scan_failed", "scan_malware_scan_incomplete", "scan_malware_scan_timeout", "scan_malware_definitions_invalid", "scan_yara_rules_invalid", "container_unhealthy", "job_deadline_exceeded", "r2_upload_503", "unknown"]) {
    assert.equal(domain.isPermanentDownloadError({ code }), false, code);
  }
  assert.equal(domain.isPermanentDownloadError(new Error("scan_malware_detected")), false);
});

test("ffprobe execution failures keep the existing four deliveries and DLQ behavior", async () => {
  let calls = 0, marked = 0, acknowledged = 0;
  const retryOptions = [];
  const context = {
    ...domain, console: { error() {} }, safeRecordUsageItems: async () => {},
    safeUsageIdentityId: value => value, safeQueueJobId: value => value, safeErrorName: () => "scan_ffprobe_failed",
    processDownloadMessage: async () => { calls++; throw Object.assign(new Error("scan_ffprobe_failed"), { code: "scan_ffprobe_failed" }); },
    markDownloadFailed: async () => { marked++; }
  };
  vm.runInNewContext(source.slice(source.indexOf("export async function handleQueueBatch("), source.indexOf("export class SecurityIntegration")).replace("export async", "async") + ";this.run = handleQueueBatch;", context);
  for (let attempts = 1; attempts <= 4; attempts++) {
    await context.run({ messages: [{ attempts, body: { type: "download", identityId: "owner", jobId: "job" }, ack() { acknowledged++; }, retry(options) { retryOptions.push(options); } }] }, {});
    assert.equal(marked, attempts === 4 ? 1 : 0);
  }
  assert.deepEqual([calls, marked, acknowledged], [4, 1, 0]);
  assert.equal(retryOptions.length, 4);
  assert.equal(retryOptions[3], undefined);
});

test("analysis readiness cannot substitute for download scanner health", async () => {
  const targets = [];
  const context = { Request, AbortSignal, console: { error() {} }, CONTAINER_HEALTH_TIMEOUT_MS: 90000, safeErrorName: () => "failure" };
  vm.runInNewContext(healthSource + ";this.run = requireHealthyContainer;", context);
  const container = { fetch: async request => { targets.push(new URL(request.url).pathname); return Response.json({ ok: true, draining: false, mode: "analysis" }); } };
  await context.run(container, true);
  await assert.rejects(context.run(container), /container_unhealthy/);
  assert.deepEqual(targets, ["/ready", "/health"]);
});

test("terminal rejection CAS cannot overwrite another lease or ready artifact", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of ["0001_downloader_foundation.sql", "0002_downloader_usage_stats.sql", "0003_downloader_progress_metrics.sql"]) {
      db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    db.exec(`INSERT INTO downloader_jobs (id,identity_id,service_link_id,client_request_id,status,source_hostname,url_hash,processing_token)
      VALUES ('job','owner','link','request','processing','example.com','hash','current')`);
    const context = { queueErrorReason: () => "rejected", classifyUsageError: () => ({ code: "scan_malware_detected", category: "malware_detected" }), auditSystem: async () => {} };
    const mark = source.slice(source.indexOf("async function markDownloadFailed("), source.indexOf("async function markAnalysisFailed("));
    vm.runInNewContext(mark + ";this.run = markDownloadFailed;", context);
    const env = { DB: { prepare: sql => ({
      bind(...values) { this.values = values; return this; },
      async first() { return db.prepare(sql).get(...this.values); },
      async run() { return { meta: db.prepare(sql).run(...this.values) }; }
    }) } };
    const message = { jobId: "job", identityId: "owner" };
    await context.run(env, message, {}, "stale");
    assert.equal(db.prepare("SELECT status FROM downloader_jobs").get().status, "processing");
    await context.run(env, message, {}, "current");
    assert.equal(db.prepare("SELECT status FROM downloader_jobs").get().status, "failed");
    db.exec("UPDATE downloader_jobs SET status='ready',object_key='downloads/job/safe',processing_token=NULL");
    await context.run(env, message, {}, "current");
    assert.equal(db.prepare("SELECT object_key FROM downloader_jobs").get().object_key, "downloads/job/safe");
  } finally { db.close(); }
});

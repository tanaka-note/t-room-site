import assert from "node:assert/strict";
import { db, env, context, api, handoff } from "./session-fixture.mjs";

db.exec("PRAGMA foreign_keys = ON");
env.DB.batch = async statements => {
  db.exec("BEGIN");
  try {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    db.exec("COMMIT");
    return results;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
};
const queue = [];
let sendFails = false;
env.TRASH_DELETION = { async send(body, options) {
  if (sendFails) throw new Error("synthetic queue outage");
  queue.push({ body, options });
} };
const deletedKeys = new Set();
const batches = [];
let r2Fails = false;
const blockedKeys = new Set();
env.FILES.delete = async keys => {
  assert.ok(Array.isArray(keys));
  assert.ok(keys.length <= 1000);
  batches.push([...keys]);
  if (r2Fails || keys.some(key => blockedKeys.has(key))) throw new Error("synthetic R2 outage");
  keys.forEach(key => deletedKeys.add(key));
};
const admin = await handoff("admin");
const headers = { "X-TCloud-Session": admin.body.sessionCacheId };
const request = (path, method = "GET", cookie = admin.cookie) => api(cookie, path, method, method === "GET" ? undefined : {}, headers);
const member = await handoff("folder-member", "general-user");
for (const [path, method] of [["/trash", "DELETE"], ["/trash/jobs", "GET"], ["/trash/jobs/00000000-0000-0000-0000-000000000000/retry", "POST"]]) {
  assert.equal((await api(member.cookie, path, method, method === "GET" ? undefined : {}, { "X-TCloud-Session": member.body.sessionCacheId })).status, 403);
  assert.equal((await api(null, path, method, method === "GET" ? undefined : {})).status, 401);
}
const csrf = await context.worker.fetch(new Request("https://example.test/cloud/api/trash", {
  method: "DELETE", headers: { Origin: "https://evil.test", Cookie: admin.cookie, ...headers }
}), env, { waitUntil() {} });
assert.equal(csrf.status, 403);

function addFile(id, folder = 7, trashed = true, stream = null) {
  db.prepare(`INSERT INTO cloud_files(id, folder_id, object_key, thumbnail_key, display_thumbnail_key, original_name,
    mime_type, media_kind, size_bytes, status, created_by, deleted_at, stream_uid)
    VALUES (?, ?, ?, ?, ?, 'fixture', 'text/plain', 'document', 100, 'ready', 'admin', ?, ?)`)
    .run(id, folder, `object-${id}`, `thumbnail-${id}`, `display-${id}`, trashed ? "2026-10-23T00:00:00Z" : null, stream);
}
const getJob = id => id ? db.prepare("SELECT * FROM cloud_trash_jobs WHERE id = ?").get(id)
  : db.prepare("SELECT * FROM cloud_trash_jobs ORDER BY rowid DESC LIMIT 1").get();
const retry = id => request(`/trash/jobs/${id}/retry`, "POST");
const remaining = id => db.prepare("SELECT * FROM cloud_files WHERE id = ?").get(id);
async function consume(jobId) {
  let acked = false;
  let retried = false;
  await context.worker.queue({ messages: [{ body: { jobId }, ack() { acked = true; }, retry() { retried = true; } }] }, env);
  assert.ok(acked || retried);
}
async function drain(jobId) {
  for (let n = 0; n < 30; n++) {
    db.prepare("UPDATE cloud_trash_jobs SET next_attempt_at = 0 WHERE id = ?").run(jobId);
    await consume(jobId);
    if (["completed", "failed"].includes(getJob(jobId).status)) return;
  }
  throw new Error("fixture job did not settle");
}

// Several R2 batches, nested folders, unfiled data, encrypted opaque objects.
db.exec(`INSERT INTO cloud_folders(id,parent_id,name,created_by,deleted_at) VALUES
  (100,NULL,'trash-root','admin','2026-10-23T00:00:00Z'),
  (101,100,'trash-child','admin','2026-10-23T00:00:00Z')`);
for (let id = 1000; id < 1175; id++) addFile(id, id % 2 ? 101 : null);
addFile(1200, 7, false);
delete env.TRASH_DELETION;
assert.equal((await request("/trash", "DELETE")).status, 503);
assert.equal(getJob(), undefined);
env.TRASH_DELETION_PAUSED = "true";
assert.equal((await request("/trash", "DELETE")).status, 503);
assert.equal(getJob(), undefined);
delete env.TRASH_DELETION_PAUSED;
env.TRASH_DELETION = { async send(body, options) { if (sendFails) throw new Error("queue outage"); queue.push({ body, options }); } };

sendFails = true;
const started = await request("/trash", "DELETE");
assert.equal(started.status, 202);
assert.equal(started.body.job.totalFiles, 175);
assert.equal(started.body.job.totalFolders, 2);
assert.equal(started.body.job.phase, "waiting", "failed Queue dispatch is visible and durable");
assert.equal(batches.length, 0, "HTTP only persists acceptance, never deletes R2 objects");
const jobId = started.body.job.id;
sendFails = false;
assert.equal((await request("/trash", "DELETE")).body.job.id, jobId, "duplicate request is idempotent");
addFile(1300); // This is deliberately newer than the snapshot.
assert.equal((await request("/trash", "DELETE")).status, 409, "new targets cannot be mistaken for acceptance into the active scope");
assert.equal(remaining(1300).purge_job_id, null);
assert.equal((await request("/files/1000/restore", "POST")).status, 409);
assert.equal((await request("/folders/100/restore", "POST")).status, 409);
assert.throws(() => db.prepare("UPDATE cloud_files SET deleted_at = NULL WHERE id = 1000").run(), /permanent deletion/);
assert.throws(() => db.prepare("UPDATE cloud_folders SET deleted_at = NULL WHERE id = 100").run(), /permanent deletion/);
assert.equal((await request("/files/1300/permanent", "DELETE")).status, 409);
queue.length = 0;
await context.worker.scheduled({ cron: "*/5 * * * *" }, env);
assert.equal(queue[0].body.jobId, jobId, "Cron recovers a lost initial dispatch");

// Simulate a still-live delivery, then a dead invocation whose lease expired.
db.prepare("UPDATE cloud_trash_jobs SET lease_token = 'other', lease_until = ? WHERE id = ?").run(Date.now() + 60000, jobId);
await consume(jobId);
assert.equal(batches.length, 0);
db.prepare("UPDATE cloud_trash_jobs SET lease_until = 1 WHERE id = ?").run(jobId);
await consume(jobId);
assert.equal(getJob().deleted_files, 80);
assert.equal(batches[0].length, 240, "body and both thumbnails use one R2 delete call");

// No browser or user cookie is involved in subsequent execution.
await drain(jobId);
assert.equal(getJob().status, "completed");
assert.equal(getJob().deleted_files, 175);
assert.equal(getJob().deleted_folders, 2);
assert.equal(db.prepare("SELECT id FROM cloud_folders WHERE id IN (100,101)").get(), undefined);
assert.ok(remaining(1200));
assert.ok(remaining(1300));
assert.equal(deletedKeys.has("object-1300"), false);
assert.equal((await request("/trash/job")).body.job.status, "completed");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cloud_audit_logs WHERE event_type = 'file_deleted'").get().n, 175);
const calls = batches.length;
await consume(jobId);
assert.equal(batches.length, calls, "duplicate completed delivery does no work");

// A partial outage retains the DB records, makes bounded retries, and supports
// explicit retry of that same scope, without claiming later trash.
r2Fails = true;
const second = await request("/trash", "DELETE");
await drain(second.body.job.id);
assert.equal(getJob().status, "failed");
assert.equal(remaining(1300).purge_attempts, 5);
assert.equal(getJob().deleted_files, 0);
addFile(1400);
r2Fails = false;
const unrelated = await request("/trash", "DELETE");
assert.notEqual(unrelated.body.job.id, second.body.job.id);
assert.equal(unrelated.body.job.totalFiles, 1);
assert.equal((await retry(second.body.job.id)).status, 409, "retry cannot compete with an active job");
assert.equal(remaining(1300).purge_attempts, 5, "rejected retry does not reset counters");
env.TRASH_DELETION_PAUSED = "true";
await drain(unrelated.body.job.id);
assert.equal((await retry(second.body.job.id)).status, 503, "acceptance pause keeps durable scopes and allows existing work to finish");
delete env.TRASH_DELETION_PAUSED;
assert.equal(remaining(1400), undefined);
assert.equal(getJob(second.body.job.id).status, "failed");
assert.equal((await retry(second.body.job.id)).status, 202);
await drain(second.body.job.id);
assert.equal(getJob(second.body.job.id).status, "completed");
assert.equal(remaining(1300), undefined);

// An interrupted R2 success before DB commit safely repeats object deletion.
addFile(1450);
const third = await request("/files/1450/permanent", "DELETE");
const originalBatch = env.DB.batch;
let failCommit = true;
env.DB.batch = async statements => {
  if (failCommit) { failCommit = false; throw new Error("synthetic DB outage after R2"); }
  return originalBatch(statements);
};
await consume(third.body.job.id);
assert.ok(deletedKeys.has("object-1450"));
assert.ok(remaining(1450));
db.prepare("UPDATE cloud_trash_jobs SET lease_until = 1 WHERE id = ?").run(third.body.job.id);
await drain(third.body.job.id);
assert.equal(getJob().deleted_files, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cloud_audit_logs WHERE event_type = 'file_deleted' AND target_id = 1450").get().n, 1);

// Legacy Stream deletion is retried; an already removed asset (404) is success.
addFile(1500, 7, true, "opaque-stream-asset");
let streamCalls = 0;
env.STREAM = { video() { return { async delete() {
  if (++streamCalls === 1) throw Object.assign(new Error("outage"), { status: 503 });
  throw Object.assign(new Error("already gone"), { status: 404 });
} }; } };
const fourth = await request("/files/1500/permanent", "DELETE");
await drain(fourth.body.job.id);
assert.equal(getJob().status, "completed");
assert.equal(streamCalls, 2);
const usage = db.prepare("SELECT * FROM cloud_usage_summary WHERE id = 1").get();
assert.equal(usage.trash_file_count, 0);
assert.equal(usage.trash_bytes, 0);
assert.equal(usage.active_file_count, 5);

// Never cascade-delete a snapshot folder containing a later/unclaimed child.
db.exec("INSERT INTO cloud_folders(id,name,created_by,deleted_at) VALUES (200,'blocked','admin','2026-10-23T00:00:00Z')");
addFile(1600, 200);
const blocked = await request("/trash", "DELETE");
db.exec("INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES (201,200,'outside-snapshot','admin')");
await drain(blocked.body.job.id);
assert.equal(getJob().status, "failed");
assert.ok(db.prepare("SELECT id FROM cloud_folders WHERE id = 201").get());
assert.equal(getJob().deleted_folders, 0);
db.exec("DELETE FROM cloud_folders WHERE id = 201");
await retry(blocked.body.job.id);
await drain(blocked.body.job.id);
assert.equal(getJob().status, "completed");
assert.equal(getJob().deleted_folders, 1);

// A single poison object must not exhaust healthy neighbours' retries.
for (let id = 1700; id < 1780; id++) addFile(id);
blockedKeys.add("object-1700");
const poison = await request("/trash", "DELETE");
await drain(poison.body.job.id);
assert.equal(getJob(poison.body.job.id).status, "failed");
assert.equal(getJob(poison.body.job.id).deleted_files, 79);
assert.equal(remaining(1700).purge_attempts, 5);
assert.equal(remaining(1700).purge_error, "r2_delete_failed");
assert.throws(() => db.prepare("UPDATE cloud_files SET object_key = 'outside' WHERE id = 1700").run(), /permanent deletion/);
addFile(1800);
blockedKeys.add("object-1800");
const another = await request("/trash", "DELETE");
await drain(another.body.job.id);
assert.equal(getJob(another.body.job.id).status, "failed");
addFile(1900);
const fresh = await request("/trash", "DELETE");
assert.equal(fresh.body.job.totalFiles, 1);
assert.equal((await retry(poison.body.job.id)).status, 409);
await drain(fresh.body.job.id);
const failedJobs = (await request("/trash/jobs")).body.jobs.filter(job => job.status === "failed");
assert.deepEqual(new Set(failedJobs.map(job => job.id)), new Set([poison.body.job.id, another.body.job.id]));
blockedKeys.delete("object-1700");
assert.equal((await retry(poison.body.job.id)).status, 202);
assert.equal((await retry(poison.body.job.id)).status, 409, "duplicate retry does not reset a live job");
await drain(poison.body.job.id);
assert.equal(remaining(1700), undefined);
assert.equal(remaining(1800).purge_job_id, another.body.job.id);
assert.equal((await request("/files/1800/restore", "POST")).status, 409);

// Before touching R2, reject any object key still used outside this scope.
addFile(2000);
db.prepare("UPDATE cloud_files SET thumbnail_key = ? WHERE id = 2000").run("object-1200");
const shared = await request("/trash", "DELETE");
await drain(shared.body.job.id);
assert.equal(getJob(shared.body.job.id).status, "failed");
assert.equal(remaining(2000).purge_error, "referenced_object");
assert.equal(deletedKeys.has("object-1200"), false);
assert.equal(deletedKeys.has("object-2000"), false);
assert.equal((await request("/trash/jobs")).body.jobs.find(job => job.id === shared.body.job.id).referencedFiles, 1);

// Reproduce acceptance racing the old upload cleanup, then retry a failed
// multipart abort. Cleanup cannot remove the accepted row or count it done.
addFile(3000);
db.prepare("UPDATE cloud_files SET status = 'uploading', multipart_upload_id = 'synthetic-upload', created_at = '2020-01-01' WHERE id = 3000").run();
let abortCalls = 0, multipartJob;
env.FILES.resumeMultipartUpload = () => ({ async abort() {
  if (++abortCalls === 1) {
    multipartJob = await request("/trash", "DELETE");
    assert.equal(multipartJob.status, 202);
  } else if (abortCalls === 2) throw new Error("transient multipart outage");
  else throw Object.assign(new Error("already completed or aborted"), { code: "NoSuchUpload" });
} });
await context.abortStaleUploads(env);
assert.ok(remaining(3000), "a stale cleanup selected before acceptance cannot delete the claimed row");
assert.equal(getJob(multipartJob.body.job.id).deleted_files, 0);
await context.worker.scheduled({ cron: "17 18 * * *" }, env);
assert.equal(abortCalls, 1, "later cleanup skips the accepted upload entirely");
assert.equal((await request("/uploads/3000", "DELETE")).status, 404);
assert.equal((await api(admin.cookie, "/uploads/3000/complete", "POST", { parts: [{ partNumber: 1, etag: "synthetic" }] }, headers)).status, 404);
assert.throws(() => db.prepare("UPDATE cloud_files SET status = 'ready', multipart_upload_id = NULL WHERE id = 3000").run(), /permanent deletion/);
const beforeAbortRetry = batches.length;
await consume(multipartJob.body.job.id);
assert.equal(batches.length, beforeAbortRetry, "no R2 object deletion before multipart abort succeeds");
assert.equal(remaining(3000).purge_error, "multipart_abort_failed");
await drain(multipartJob.body.job.id);
assert.equal(remaining(3000), undefined);
assert.equal(abortCalls, 3);
assert.equal(getJob(multipartJob.body.job.id).deleted_files, 1);
assert.equal(db.prepare("SELECT COUNT(*) n FROM cloud_audit_logs WHERE event_type='file_deleted' AND target_id=3000").get().n, 1);
assert.equal(db.prepare("SELECT trash_file_count FROM cloud_usage_summary WHERE id=1").get().trash_file_count,
  db.prepare("SELECT COUNT(*) n FROM cloud_files WHERE deleted_at IS NOT NULL AND status='ready'").get().n);
console.log("PASS durable trash deletion: acceptance, permissions/CSRF, snapshots, batches, leases/recovery, retry, audit, usage, Stream and browser-independent completion");

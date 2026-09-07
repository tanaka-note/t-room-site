import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import * as domain from '../src/downloader-domain.js';
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const part = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
function setup(processingSeconds = 600) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const now = Math.floor(Date.now() / 1000);
  const grant = { jobId: 'job', processingToken: 'winner', objectKey: 'downloads/job/winner', maxBytes: 1000, expiresAt: now - processingSeconds + 870 };
  db.prepare(`INSERT INTO downloader_jobs(id,identity_id,service_link_id,client_request_id,status,source_hostname,url_hash,processing_at,processing_token,processing_lease_expires_at)
    VALUES('job','owner','link','request','processing','example.com','hash',datetime(?, 'unixepoch'),'winner',?)`).run(now - processingSeconds, grant.expiresAt);
  const jobs = [], tasks = [], logs = [];
  const env = {
    DOWNLOAD_TTL_SECONDS: '3600',
    DB: { prepare(sql) { return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args); },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; }
    }; } }; } },
    DOWNLOADS: { async put() {}, async delete() {}, async get() { throw Error('unexpected R2 read'); } }
  };
  const context = {
    ...domain, Request, Response, Headers, Date, Math, json: Response.json,
    console: { log() {}, error(value) { logs.push(JSON.parse(value)); } },
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    verifyInternalGrant: async () => grant, nowSeconds: () => Math.floor(Date.now() / 1000),
    decodeHeaderValue: x => x, normalizeNormalizationMode: () => 'PASS_THROUGH',
    downloadTtl: e => Number(e.DOWNLOAD_TTL_SECONDS), contentDisposition: () => 'attachment',
    safeRecordUsageItems: async () => {}, safeErrorName: e => e.message,
    sendJobMessage: async (_env, body, options) => jobs.push({ body, options }),
    waitUntil(promise) { tasks.push(promise); }, auditSystem: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(part('async function handleContainerUpload(', 'async function listJobs(') +
    part('async function ownedJob(', 'async function cleanupExpiredJobs(') +
    source.match(/^function safeMetricHeader.*$/m)[0] +
    ';globalThis.upload=handleContainerUpload;globalThis.serve=serveDownload;globalThis.remove=deleteJobObject;', context);
  const request = () => new Request('https://internal/upload', { method: 'PUT', body: 'safe', headers: {
    'Content-Length': '4', 'Content-Type': 'video/mp4', 'X-Filename': 'fixture.mp4', 'X-Content-SHA256': 'a'.repeat(64)
  } });
  return { db, env, context, grant, jobs, tasks, logs, request, row: () => db.prepare('SELECT * FROM downloader_jobs').get() };
}

for (const seconds of [0, 600]) test(`READY timestamp owns full 3600 seconds after ${seconds}s processing; Queue uses committed expiry`, async () => {
  const h = setup(seconds);
  try {
    let releasePut, putStarted;
    const started = new Promise(resolve => { putStarted = resolve; });
    h.env.DOWNLOADS.put = async () => { putStarted(); await new Promise(resolve => { releasePut = resolve; }); };
    const pending = h.context.upload(h.request(), h.env);
    await started;
    assert.equal(h.row().status, 'processing');
    assert.equal(h.row().expires_at, null);
    releasePut();
    const result = await pending;
    assert.equal(result.status, 200);
    const response = await result.json(), row = h.row();
    const readyAt = Date.parse(row.downloaded_at.replace(' ', 'T') + 'Z') / 1000;
    assert.equal(row.expires_at, readyAt + 3600);
    assert.equal(response.expiresAt, row.expires_at);
    assert.ok(row.expires_at > h.grant.expiresAt);
    assert.ok(Math.abs(readyAt - Math.floor(Date.now() / 1000)) <= 1);
    await Promise.all(h.tasks);
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].body.type, 'delete');
    assert.equal(h.jobs[0].body.jobId, 'job');
    assert.ok(h.jobs[0].options.delaySeconds >= 3598 && h.jobs[0].options.delaySeconds <= 3600);
    h.context.nowSeconds = () => readyAt + 120;
    const replay = await h.context.upload(h.request(), h.env);
    assert.equal((await replay.json()).expiresAt, row.expires_at, 'replay cannot extend the retention window');
    assert.equal(h.jobs.length, 1);
  } finally { h.db.close(); }
});

test('Queue reservation never delays upload response; send failure leaves READY for Cron recovery', { timeout: 2000 }, async () => {
  const h = setup();
  try {
    let rejectSend;
    h.context.sendJobMessage = () => new Promise((_resolve, reject) => { rejectSend = reject; });
    const result = await h.context.upload(h.request(), h.env);
    assert.equal(result.status, 200);
    assert.equal(h.row().status, 'ready');
    assert.ok(h.row().object_key);
    rejectSend(Error('queue unavailable'));
    await Promise.all(h.tasks);
    assert.equal(h.logs[0].event, 'downloader_expiry_queue_failed');
    assert.equal(h.row().status, 'ready');
  } finally { h.db.close(); }
});

test('expired file is denied immediately without R2 read/delete; failed deletion preserves retry state', async () => {
  const h = setup();
  try {
    await h.context.upload(h.request(), h.env);
    h.context.nowSeconds = () => h.row().expires_at;
    let deletes = 0, reads = 0;
    h.env.DOWNLOADS.get = async () => { reads++; throw Error('must not read'); };
    h.env.DOWNLOADS.delete = async () => { deletes++; throw Error('R2 unavailable'); };
    await assert.rejects(h.context.serve({}, h.env, { identityId: 'owner' }, 'job'), e => e.status === 410);
    assert.equal(reads, 0); assert.equal(deletes, 0);
    await assert.rejects(h.context.remove(h.env, 'job', 'expired'), /R2 unavailable/);
    assert.ok(h.row().object_key);
    assert.equal(h.row().status, 'ready');
    assert.equal(domain.publicJob(h.row()).deletionConfirmed, false);
    h.env.DOWNLOADS.delete = async () => {};
    await h.context.remove(h.env, 'job', 'expired');
    assert.equal(h.row().object_key, null);
    assert.equal(h.row().status, 'expired');
    assert.equal(domain.publicJob(h.row()).deletionConfirmed, true);
    assert.equal(h.logs[0].event, 'downloader_object_delete_failed');
  } finally { h.db.close(); }
});

test('early Queue delivery and confirmed deleted/cancelled states cannot delete a retained artifact', async () => {
  const h = setup();
  try {
    await h.context.upload(h.request(), h.env);
    h.env.DOWNLOADS.delete = async () => assert.fail('unexpected deletion');
    await h.context.remove(h.env, 'job', 'expired');
    assert.equal(h.row().status, 'ready');
    for (const state of ['deleted', 'cancelled']) {
      h.db.prepare('UPDATE downloader_jobs SET status=?, cancelled_at=CURRENT_TIMESTAMP, deleted_at=CURRENT_TIMESTAMP').run(state);
      h.context.nowSeconds = () => h.row().expires_at + 1;
      await h.context.remove(h.env, 'job', 'expired');
      assert.equal(h.row().status, state);
    }
  } finally { h.db.close(); }
});

test('late missing-object response cannot replace manual deletion', async () => {
  const h = setup();
  try {
    await h.context.upload(h.request(), h.env);
    let releaseGet, started;
    const readStarted = new Promise(resolve => { started = resolve; });
    h.env.DOWNLOADS.get = () => { started(); return new Promise(resolve => { releaseGet = resolve; }); };
    const pending = h.context.serve({}, h.env, { identityId: 'owner' }, 'job');
    await readStarted;
    await h.context.remove(h.env, 'job', 'deleted');
    releaseGet(null);
    await assert.rejects(pending, e => e.status === 410);
    assert.equal(h.row().status, 'deleted');
  } finally { h.db.close(); }
});

test('expired upload grant cannot be used just because an artifact would receive a new retention deadline', async () => {
  const h = setup();
  try {
    Object.assign(h.context, {
      decoder: new TextDecoder(), base64UrlToBytes: x => new Uint8Array(Buffer.from(x, 'base64url')),
      hmac: async () => 'test-signature', safeEqual: async (a, b) => a === b
    });
    vm.runInContext(part('async function verifyInternalGrant(', 'async function signSession(') + ';globalThis.verify=verifyInternalGrant;', h.context);
    const header = expiresAt => 'Bearer ' + Buffer.from(JSON.stringify({ ...h.grant, expiresAt })).toString('base64url') + '.test-signature';
    const now = h.context.nowSeconds();
    assert.equal(await h.context.verify(header(now), { INTERNAL_SIGNING_SECRET: 'fixture-only' }), null);
    assert.ok(await h.context.verify(header(now + 1), { INTERNAL_SIGNING_SECRET: 'fixture-only' }));
    const process = part('async function processDownloadMessage(', 'function normalizeContainerMetrics(');
    assert.match(process, /uploadGrantExpiresAt = leaseExpiresAt/);
    assert.doesNotMatch(process, /downloadTtl\(env\)|deleteJobObject|sendJobMessage/);
  } finally { h.db.close(); }
});

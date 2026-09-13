import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { definitionStatus, monitorDefinitions, runDefinitionSchedule } from '../../security-worker/src/definition-status.js';
import { refresh, candidateReport, definitionTarget } from '../tools/refresh-definitions.mjs';
import { notifyGithub, monitor } from '../tools/monitor-definitions.mjs';
import { ACCOUNT, SECURITY_DB, APPLICATION_PATH, cloudflareClient, CloudflareError, safeError } from '../tools/definition-api.mjs';

import { configurationHash, settleObservation, ROLLOUT_STATUSES, MAX_SUBMISSIONS } from '../tools/definition-rollout.mjs';
import { claimLease, LEASE_SECONDS } from '../tools/definition-lease.mjs';

const now = 1800000000;
const image = `registry.cloudflare.com/${ACCOUNT}/t-room-downloader-downloadercontainer@sha256:${'a'.repeat(64)}`;
const next = image.replace(/a{64}$/, 'b'.repeat(64));
const report = { verified: true, definitionUnix: now - 3600, verifiedAt: now, maxAgeSeconds: 604800 };
const good = { image, definition_unix: now - 86400, verified_at: now - 10, last_attempt_at: now - 10, last_success_at: now - 10, last_result: 'success', automation_enabled: 1, hourly_monitor_checked_at: now - 10, deployment_matches: 1, image_checked_at: now - 10 };
const migration = await readFile(new URL('../../security-worker/migrations/0014_clamav_definition_updates.sql', import.meta.url), 'utf8');
test('rollout retains resource/log settings without writing platform-managed runtime/network fields', () => {
  assert.deepEqual(definitionTarget({image,vcpu:1,memory:'6GiB',memory_mib:6144,disk:{size_mb:12000,size:'12GB'},runtime:'firecracker',network:{mode:'private'},observability:{logs:{enabled:true}}},next),
    {image:next,vcpu:1,memory_mib:6144,disk:{size_mb:12000},observability:{logs:{enabled:true}}});
});
const hourlyMigration = await readFile(new URL('../../security-worker/migrations/0015_hourly_definition_heartbeat.sql', import.meta.url), 'utf8');
const intentMigration = await readFile(new URL('../../security-worker/migrations/0018_definition_rollout_intent.sql', import.meta.url), 'utf8');
function database() { const db = new DatabaseSync(':memory:'); db.exec(migration); db.exec(hourlyMigration); db.exec(intentMigration); return db; }
function envFor(db) { return { DB: {
  prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; }, async first() { return db.prepare(sql).get(...this.values); }, async run() { return { meta: db.prepare(sql).run(...this.values) }; }, sql }; },
  async batch(statements) { db.exec('BEGIN'); try { for (const s of statements) db.prepare(s.sql).run(...s.values); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
} }; }
function setGood(db) {
  for (const [key,value] of Object.entries(good)) db.prepare(`UPDATE security_definition_updates SET ${key}=?`).run(value);
}

test('five-day warning, seven-day refusal observation, updater/monitor stop and unknown are distinct', () => {
  assert.equal(definitionStatus(good, now).state, 'healthy');
  assert.ok(definitionStatus({ ...good, definition_unix: now - 5 * 86400 }, now).issues.includes('expiring'));
  assert.ok(definitionStatus({ ...good, definition_unix: now - 7 * 86400 - 1 }, now).issues.includes('expired'));
  assert.ok(definitionStatus({ ...good, last_attempt_at: now - 36 * 3600 - 1 }, now).issues.includes('updater_stopped'));
  assert.ok(definitionStatus({ ...good, hourly_monitor_checked_at: now - 3 * 3600 - 1 }, now).issues.includes('monitor_stopped'));
  assert.ok(definitionStatus({ ...good, failure_count: 2 }, now).issues.includes('update_failed'));
  assert.ok(definitionStatus({ ...good, deployment_matches: 0 }, now).issues.includes('deployment_unknown'));
  assert.ok(definitionStatus(null, now).issues.includes('unknown'));
  assert.ok(definitionStatus({ ...good, definition_unix: now + 3600 }, now).issues.includes('unknown'));
});

test('candidate gates reject signature failure, lifetime changes, stale and future definitions', () => {
  assert.equal(candidateReport(report, now), report);
  for (const change of [{ verified: false }, { definitionUnix: now + 301 }, { definitionUnix: now - 5 * 86400 }, { verifiedAt: now - 301 }, { maxAgeSeconds: 8 * 86400 }]) {
    assert.throws(() => candidateReport({ ...report, ...change }, now), /candidate_invalid/);
  }
});

test('additive migration preserves existing history and does not invent old measurements', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE security_audit_events(id TEXT, occurred_at TEXT); INSERT INTO security_audit_events VALUES ('history','2025-01-01')");
    db.exec(migration);
    assert.equal(db.prepare('SELECT id FROM security_audit_events').get().id, 'history');
    const row = db.prepare('SELECT * FROM security_definition_updates').get();
    assert.equal(row.definition_unix, null); assert.equal(row.last_success_at, null);
    assert.ok(definitionStatus(row, now).issues.includes('unknown'));
  } finally { db.close(); }
});

test('external monitor detects a stopped Worker monitor and status access failure', async () => {
  const h = harness(); const notices = [];
  const github = async (path, method, body) => { if (!method) return []; notices.push(body); return {}; };
  try {
    h.db.prepare('UPDATE security_definition_updates SET hourly_monitor_checked_at=?').run(now - 3 * 3600 - 1);
    assert.equal(await monitor({ api: h.api, github, now }), 'monitor_stopped');
    const failed = await monitor({ api: async () => { throw Error('unavailable'); }, github, now });
    assert.notEqual(failed, 'healthy');
    assert.equal(notices.length, 2);
  } finally { h.db.close(); }
});

test('independent lightweight monitor deduplicates incidents and records recovery', async () => {
  const db = database();
  try {
    setGood(db);
    const env = envFor(db);
    await monitorDefinitions(env, now);
    await monitorDefinitions(env, now + 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_definition_events').get().n, 1);
    db.exec('UPDATE security_definition_updates SET failure_count=2');
    await monitorDefinitions(env, now + 2);
    await monitorDefinitions(env, now + 3);
    db.exec('UPDATE security_definition_updates SET failure_count=0');
    await monitorDefinitions(env, now + 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_definition_events').get().n, 3);
    assert.equal(db.prepare('SELECT incident FROM security_definition_updates').get().incident, 'healthy');
  } finally { db.close(); }
});

function harness({ failure, jobs = 0 } = {}) {
  const db = database(); setGood(db);
  let posts = 0, builds = 0;
  const h = { db, jobs, autoComplete: true, trace: [], hooks: {},
    app: { configuration: { image }, version: 1, rollout_active_grace_period: 900, active_rollout_id: null }, rollouts: [],
    row: () => db.prepare('SELECT * FROM security_definition_updates').get(), counts: () => ({ rollouts: posts, builds }),
    now: () => now, sleep: async () => {}, maxPolls: 4 };
  h.complete = () => { h.app.configuration.image = next; h.app.version = 2; h.app.active_rollout_id = null; if (h.rollouts[0]) h.rollouts[0].status = 'completed'; };
  h.create = () => {
    const r = { id: 'rollout', status: 'progressing', current_configuration: { image }, target_configuration: { image: next }, current_version: 1, target_version: 2 };
    h.rollouts.push(r); h.app.active_rollout_id = r.id; return structuredClone(r);
  };
  h.api = async (path, method = 'GET', body) => {
    h.trace.push({ path, method });
    if (path.includes(`/d1/database/${SECURITY_DB}/query`)) {
      await h.hooks.sql?.(body);
      const statement = db.prepare(body.sql);
      return [{ success: true, ...(body.sql.startsWith('SELECT') ? { results: statement.all(...body.params) } : { results: [], meta: statement.run(...body.params) }) }];
    }
    if (path.includes('/d1/database/')) { await h.hooks.jobs?.(); return [{ success: true, results: [{ count: h.jobs }] }]; }
    if (path.endsWith('/credentials')) return { username: 'test', password: 'test' };
    if (path === APPLICATION_PATH) { await h.hooks.app?.(); return structuredClone(h.app); }
    if (path.endsWith('/rollouts') && method === 'GET') { await h.hooks.list?.(); return structuredClone(h.rollouts); }
    if (path.endsWith('/rollouts') && method === 'POST') {
      posts++;
      assert.equal(h.row().pending_image, next, 'intent durable BEFORE POST');
      assert.equal(h.row().pending_attempts, posts, 'dispatch marker durable BEFORE POST');
      assert.deepEqual(body.steps.map(step => step.step_size.percentage), [10, 100]);
      assert.ok(body.steps.every(step => typeof step.description === 'string'));
      if (h.hooks.post) return h.hooks.post();
      return h.create();
    }
    if (path.includes('/rollouts/')) {
      if (h.hooks.get) return h.hooks.get(path);
      if (h.autoComplete) h.complete();
      const r = h.rollouts.find(r => path.endsWith('/' + r.id));
      if (!r) throw new CloudflareError({ status: 404 });
      return structuredClone(r);
    }
    throw Error('unexpected_test_api');
  };
  h.docker = args => {
    if (args[0] === 'build') { builds++; if (failure === 'build') throw Error('definition_docker_failed'); }
    if (args[0] === 'run') return JSON.stringify(failure === 'signature' ? { ...report, verified: false } : report);
    if (args[0] === 'image') return JSON.stringify([next]);
    return '';
  };
  h.seed = (overrides = {}) => {
    const values = { pending_image: next, pending_previous_image: image, pending_source_image: image,
      pending_definition_unix: report.definitionUnix, pending_verified_at: report.verifiedAt, pending_started_at: now,
      pending_state: 'prepared', pending_version: 1, pending_configuration_hash: configurationHash(h.app), pending_rollout_ids: '[]', ...overrides };
    for (const [key,value] of Object.entries(values)) db.prepare(`UPDATE security_definition_updates SET ${key}=?`).run(value);
  };
  return h;
}

test('normal update records only a verified completed image-only rollout', async () => {
  const h = harness();
  try {
    await refresh(h);
    assert.equal(h.row().image, next);
    assert.equal(h.row().previous_image, image);
    assert.equal(h.row().source_image, image);
    assert.equal(h.row().definition_unix, report.definitionUnix);
    assert.equal(h.row().last_result, 'success');
    assert.equal(h.row().failure_count, 0);
    assert.deepEqual(h.counts(), { rollouts: 1, builds: 1 });
  } finally { h.db.close(); }
});

test('explicit code release verifies local browser fixtures before rollout and updates daily code base', async () => {
  const h=harness(),calls=[];
  const docker=args=>{calls.push(args);return h.docker(args)};
  try {
    await refresh({...h,docker,releaseCode:true});
    const build=calls.find(x=>x[0]==='build');
    assert.ok(build.includes(`CLAMAV_DEFINITION_REFRESH=${h.row().run_id}`));
    assert.ok(calls.some(x=>x.includes('test_main_video.py') && x.includes('none')));
    assert.ok(calls.find(x=>x.includes('test_main_video.py')).includes('HOME=/work'));
    assert.equal(h.row().source_image,next);
    assert.equal(h.row().image,next);
  } finally {h.db.close()}
});

test('failed code-release fixture prevents push and rollout', async () => {
  const h=harness(),calls=[];
  const docker=args=>{calls.push(args);if(args.includes('test_main_video.py'))throw Error('fixture_failed');return h.docker(args)};
  try{
    await assert.rejects(refresh({...h,docker,releaseCode:true}),/fixture_failed/);
    assert.equal(h.counts().rollouts,0);assert.equal(calls.some(x=>x[0]==='push'),false);assert.equal(h.row().image,image);
  }finally{h.db.close()}
});

test('analysis-only release inherits production runtime and signatures without repeated engine scans', async () => {
  const h=harness(),calls=[];
  try {
    await refresh({...h,releaseCode:true,analysisOnly:true,docker:args=>{calls.push(args);return h.docker(args)}});
    const build=calls.find(x=>x[0]==='build');
    assert.ok(build.includes(`BASE_IMAGE=${image}`));assert.ok(build.some(x=>x.endsWith('analysis.Dockerfile')));
    assert.ok(calls.some(x=>x.includes('test_main_video.py')));
    assert.ok(calls.some(x=>x.includes('/tmp/verify-definitions.py') && x.includes('--definitions-only')));
    assert.equal(h.row().source_image,next);assert.equal(h.row().definition_unix,report.definitionUnix);
    await assert.rejects(refresh({...h,analysisOnly:true,releaseCode:false}),/requires_code/);
  } finally {h.db.close()}
});

test('failed build/signature preserves last verified image and consecutive failures', async () => {
  for (const failure of ['build', 'signature']) {
    const h = harness({ failure });
    try {
      await assert.rejects(refresh(h));
      await assert.rejects(refresh(h));
      assert.equal(h.row().image, image);
      assert.equal(h.row().definition_unix, good.definition_unix);
      assert.equal(h.row().failure_count, 2);
      assert.equal(h.counts().rollouts, failure === 'rollout' ? 2 : 0);
    } finally { h.db.close(); }
  }
});

test('active jobs defer rollout and an updater lease prevents concurrent runs', async () => {
  const h = harness({ jobs: 1 });
  try {
    assert.equal((await refresh(h)).deferred, true);
    assert.equal(h.row().image, image);
    assert.equal(h.counts().rollouts, 0);
    h.db.prepare('UPDATE security_definition_updates SET lease_until=?').run(now + 1);
    await assert.rejects(refresh(h), /already_running/);
  } finally { h.db.close(); }
});

test('GitHub notification is one incident with state changes and recovery, not repeated alerts', async () => {
  const issues = []; const comments = [];
  const github = async (path, method = 'GET', body) => {
    if (method === 'GET') return issues;
    if (method === 'PATCH') { Object.assign(issues[0], body); return issues[0]; }
    if (path.endsWith('/comments')) { comments.push(body); return body; }
    issues.push({ ...body, number: 1, state: 'open' }); return issues[0];
  };
  await notifyGithub('expiring', github);
  await notifyGithub('expiring', github);
  assert.equal(issues.length, 1); assert.equal(comments.length, 0);
  await notifyGithub('expired', github);
  await notifyGithub('healthy', github);
  await notifyGithub('healthy', github);
  assert.equal(issues[0].state, 'closed'); assert.equal(comments.length, 2);
});


test('hourly migration retains daily history without manufacturing an hourly heartbeat', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("UPDATE security_definition_updates SET monitor_checked_at=?,incident='healthy'").run(now);
    db.exec("INSERT INTO security_definition_events(occurred_at,state) VALUES (1,'healthy')");
    db.exec(hourlyMigration);
    const row = db.prepare('SELECT * FROM security_definition_updates').get();
    assert.equal(row.monitor_checked_at, now);
    assert.equal(row.hourly_monitor_checked_at, null);
    assert.equal(row.hourly_monitor_started_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_definition_events').get().n, 1);
    assert.ok(definitionStatus({ ...good, ...row }, now).issues.includes('monitor_stopped'));
  } finally { db.close(); }
});

test('daily maintenance cannot recover stopped hourly monitoring; hourly completion can', async () => {
  const db = database();
  try {
    setGood(db);
    db.exec('UPDATE security_definition_updates SET hourly_monitor_checked_at=NULL');
    const env = envFor(db);
    assert.equal((await monitorDefinitions(env, now, 'daily')).state, 'monitor_stopped');
    let row = db.prepare('SELECT * FROM security_definition_updates').get();
    assert.equal(row.monitor_checked_at, now);
    assert.equal(row.hourly_monitor_checked_at, null);
    assert.equal(row.incident, 'monitor_stopped');
    assert.equal((await monitorDefinitions(env, now + 1, 'hourly')).state, 'healthy');
    row = db.prepare('SELECT * FROM security_definition_updates').get();
    assert.equal(row.hourly_monitor_started_at, now + 1);
    assert.equal(row.hourly_monitor_checked_at, now + 1);
    const later = now + 3 * 3600 + 2;
    assert.equal((await monitorDefinitions(env, later, 'daily')).state, 'monitor_stopped');
    assert.equal(db.prepare('SELECT hourly_monitor_checked_at AS t FROM security_definition_updates').get().t, now + 1);
    assert.ok(definitionStatus({ ...good, hourly_monitor_checked_at: now + 301 }, now).issues.includes('monitor_stopped'));
  } finally { db.close(); }
});

test('scheduled entry routes exact hourly and daily cron without running cleanup hourly', async () => {
  const db = database();
  let cleanups = 0;
  try {
    setGood(db);
    const env = envFor(db);
    await runDefinitionSchedule({ cron: '17 * * * *' }, env, async () => { cleanups++; });
    const hourly = db.prepare('SELECT hourly_monitor_checked_at AS t FROM security_definition_updates').get().t;
    assert.ok(hourly > 0); assert.equal(cleanups, 0);
    await runDefinitionSchedule({ cron: '41 18 * * *' }, env, async () => { cleanups++; });
    assert.equal(cleanups, 1);
    assert.equal(db.prepare('SELECT hourly_monitor_checked_at AS t FROM security_definition_updates').get().t, hourly);
    await assert.rejects(runDefinitionSchedule({ cron: '* * * * *' }, env, async () => { cleanups++; }), /unexpected_cron/);
    assert.equal(cleanups, 1);
    await assert.rejects(runDefinitionSchedule({ cron: '41 18 * * *' }, env, async () => { throw Error('cleanup failure'); }), /cleanup failure/);
  } finally { db.close(); }
});

test('D1 failures never advance completion or falsely recover the incident', async () => {
  for (const failure of ['start_record', 'read', 'complete_record']) {
    const db = database();
    try {
      setGood(db); db.exec("UPDATE security_definition_updates SET hourly_monitor_checked_at=NULL,incident='monitor_stopped'");
      const env = envFor(db), originalPrepare = env.DB.prepare;
      env.DB.prepare = sql => {
        const statement = originalPrepare(sql);
        if (failure === 'start_record') statement.run = async () => { throw Error('private error'); };
        if (failure === 'read') statement.first = async () => { throw Error('private error'); };
        return statement;
      };
      if (failure === 'complete_record') db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF hourly_monitor_checked_at ON security_definition_updates BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
      await assert.rejects(monitorDefinitions(env, now, 'hourly'), new RegExp('definition_monitor_' + failure + '_failed'));
      const row = db.prepare('SELECT * FROM security_definition_updates').get();
      assert.equal(row.hourly_monitor_checked_at, null);
      assert.equal(row.incident, 'monitor_stopped');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_definition_events').get().n, 0);
      assert.equal(row.hourly_monitor_started_at, failure === 'start_record' ? null : now);
    } finally { db.close(); }
  }
});

test('GitHub and dashboard share hourly-only stop and recovery judgement', async () => {
  const h = harness(), notices = [];
  const github = async (_path, method, body) => { if (!method) return []; notices.push(body); return {}; };
  try {
    h.db.exec('UPDATE security_definition_updates SET hourly_monitor_checked_at=NULL');
    await monitorDefinitions(envFor(h.db), now, 'daily');
    assert.equal(await monitor({ api: h.api, github, now }), 'monitor_stopped');
    await monitorDefinitions(envFor(h.db), now, 'hourly');
    assert.equal(await monitor({ api: h.api, github, now }), 'healthy');
    assert.equal(definitionStatus(h.row(), now).state, 'healthy');
    assert.equal(notices.length, 1);
  } finally { h.db.close(); }
});

test('intent migration preserves every existing column, events and unrelated data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration); db.exec(hourlyMigration); setGood(db);
    db.exec("INSERT INTO security_definition_events(occurred_at,state) VALUES (2,'deployment_unknown')");
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep')");
    const original = db.prepare('SELECT * FROM security_definition_updates').get();
    db.exec(intentMigration);
    const row = db.prepare('SELECT * FROM security_definition_updates').get();
    for (const [key, value] of Object.entries(original)) assert.equal(row[key], value, key);
    assert.equal(row.pending_image, null); assert.equal(row.pending_attempts, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_definition_events').get().n, 1);
    assert.equal(db.prepare('SELECT value FROM unrelated').get().value, 'keep');
  } finally { db.close(); }
});

test('500 with no provider creation: reconcile repeatedly, never blindly resend, retain evidence for next run', async () => {
  const h = harness();
  h.hooks.post = () => { throw new CloudflareError({ status: 500, codes: [1000], method: 'POST', stage: 'rollout_list' }); };
  try {
    assert.equal((await refresh(h)).state, 'reconciliation_stuck');
    const afterPost = h.trace.slice(h.trace.findIndex(x => x.path.endsWith('/rollouts') && x.method === 'POST') + 1);
    assert.ok(afterPost.filter(x => x.path === APPLICATION_PATH).length >= 6);
    assert.ok(afterPost.filter(x => x.path.endsWith('/rollouts') && x.method === 'GET').length >= 3);
    assert.equal(h.counts().rollouts, 1); assert.equal(h.row().pending_image, next);
    assert.equal(h.row().pending_attempts, MAX_SUBMISSIONS);
    assert.equal((await refresh(h)).state, 'reconciliation_stuck');
    assert.deepEqual(h.counts(), { builds: 1, rollouts: 1 });
    assert.ok(definitionStatus(h.row(), now).issues.includes('reconciliation_stuck'));
  } finally { h.db.close(); }
});

for (const errorKind of ['500', 'timeout', 'connection_reset', 'parse']) {
  test(`${errorKind} POST outcome: adopt the existing rollout, exactly one POST`, async () => {
    const h = harness();
    h.hooks.post = () => { h.create(); throw errorKind === '500' ? new CloudflareError({ status: 500 }) : Error(errorKind); };
    try {
      await refresh(h);
      assert.equal(h.row().last_result, 'success'); assert.equal(h.row().image, next);
      assert.equal(h.counts().rollouts, 1); assert.equal(h.row().pending_image, null);
    } finally { h.db.close(); }
  });
}

test('500 response after target already applied finalizes the verified intent without another POST', async () => {
  const h = harness();
  h.hooks.post = () => { h.create(); h.complete(); throw new CloudflareError({ status: 500 }); };
  try { await refresh(h); assert.equal(h.row().image, next); assert.equal(h.counts().rollouts, 1); }
  finally { h.db.close(); }
});

test('target digest without active ID can recover even when response and rollout record are unavailable', async () => {
  const h = harness(); h.seed({ pending_attempts: 1, pending_state: 'rollout_ambiguous' }); h.complete();
  try { await refresh(h); assert.equal(h.row().image, next); assert.deepEqual(h.counts(), { builds: 0, rollouts: 0 }); }
  finally { h.db.close(); }
});

test('stable dangling ID requires three individual 404s, lists and application rereads; no repair mutation', async () => {
  for (const withIntent of [true, false]) {
    const h = harness(); if (withIntent) h.seed({ pending_attempts: 1 });
    h.app.active_rollout_id = 'ghost';
    h.hooks.get = () => { throw new CloudflareError({ status: 404 }); };
    try {
      const result = await refresh(h);
      assert.equal(result.state, 'stale_rollout'); assert.equal(h.row().pending_state, 'stale_rollout');
      assert.equal(h.counts().rollouts, 0);
      assert.equal(h.trace.filter(x => x.path.endsWith('/rollouts/ghost')).length, 3);
      assert.equal(h.trace.filter(x => x.path.endsWith('/rollouts') && x.method === 'GET').length, 3);
    } finally { h.db.close(); }
  }
});

test('temporary 404 with a list entry is not stale; existing rollout becomes readable', async () => {
  const h = harness(); h.seed({ pending_attempts: 1 }); h.create(); let gets = 0;
  h.hooks.get = () => { if (++gets < 3) throw new CloudflareError({ status: 404 }); if (gets > 3) h.complete(); return structuredClone(h.rollouts[0]); };
  try { await refresh(h); assert.equal(h.row().image, next); assert.equal(h.counts().rollouts, 0); assert.ok(gets >= 3); }
  finally { h.db.close(); }
});

test('dangling ID which naturally disappears and reaches target is reconciled, never overwritten', async () => {
  const h = harness(); h.seed({ pending_attempts: 1 }); h.app.active_rollout_id = 'ghost';
  h.hooks.get = () => { h.complete(); throw new CloudflareError({ status: 404 }); };
  try { await refresh(h); assert.equal(h.row().image, next); assert.equal(h.counts().rollouts, 0); }
  finally { h.db.close(); }
});

test('progressing past local wait deadline remains pending and next run resumes without build or POST', async () => {
  const h = harness(); h.autoComplete = false;
  try {
    const result = await refresh(h);
    assert.equal(result.state, 'rollout_pending'); assert.equal(h.row().pending_rollout_id, 'rollout');
    assert.equal(h.row().last_result, 'rollout_pending'); assert.equal(h.row().failure_count, 0);
    assert.equal(h.row().lease_until, null); assert.equal(h.row().image, image);
    const owner = h.row().run_id; h.autoComplete = true;
    await refresh(h);
    assert.notEqual(h.row().run_id, owner); assert.equal(h.row().image, next);
    assert.deepEqual(h.counts(), { builds: 1, rollouts: 1 });
  } finally { h.db.close(); }
});

test('pending intent retains source_image across resumed release_code/analysisOnly runs', async () => {
  const h = harness(); h.autoComplete = false;
  try {
    await refresh({ ...h, releaseCode: true, analysisOnly: true });
    assert.equal(h.row().pending_source_image, next);
    h.autoComplete = true;
    await refresh(h);
    assert.equal(h.row().source_image, next); assert.equal(h.row().previous_image, image);
  } finally { h.db.close(); }
});

test('different external image, target or version is a conflict; no overwrite/rollback', async () => {
  for (const change of ['image', 'rollout', 'version', 'configuration']) {
    const h = harness(); h.seed({ pending_attempts: 1 });
    if (change === 'image') h.app.configuration.image = image.replace(/a{64}$/, 'c'.repeat(64));
    if (change === 'version') h.app.version++;
    if (change === 'configuration') h.app.configuration.vcpu = 2;
    if (change === 'rollout') { h.create(); h.rollouts[0].target_configuration.image = image.replace(/a{64}$/, 'c'.repeat(64)); h.autoComplete = false; }
    try { assert.equal((await refresh(h)).state, 'rollout_conflict'); assert.equal(h.counts().rollouts, 0); assert.equal(h.row().image, image); }
    finally { h.db.close(); }
  }
});

test('jobs arriving immediately before a resumed prepared submission defer the mutation', async () => {
  const h = harness(); h.seed(); h.hooks.jobs = () => { h.jobs = 1; };
  try {
    assert.equal((await refresh(h)).state, 'rollout_deferred');
    assert.equal(h.counts().rollouts, 0); assert.equal(h.row().pending_attempts, 0);
    h.jobs = 0; h.hooks.jobs = null; await refresh(h); assert.equal(h.row().image, next);
  } finally { h.db.close(); }
});

test('official terminal statuses and unknown status stop explicitly, without endless polling', async () => {
  assert.deepEqual(ROLLOUT_STATUSES, ['pending', 'progressing', 'completed', 'reverted', 'replaced']);
  for (const status of ['reverted', 'replaced', 'future_status', 'failed', 'cancelled', 'rolled_back']) {
    const h = harness(); h.seed({ pending_attempts: 1, pending_rollout_id: 'rollout' }); h.create(); h.autoComplete = false;
    h.rollouts[0].status = status;
    try {
      const result = await refresh(h);
      assert.equal(result.state, ['reverted', 'replaced'].includes(status) ? `rollout_${status}` : 'rollout_unknown_status');
      assert.equal(h.row().image, image); assert.equal(h.counts().rollouts, 0);
      assert.ok(h.trace.filter(x => x.path.endsWith('/rollouts/rollout')).length <= 2);
    } finally { h.db.close(); }
  }
});

test('pending verified candidate cannot be published at five days or finalized at seven days', async () => {
  for (const applied of [false, true]) {
    const h = harness(); h.seed({ pending_definition_unix: now - (applied ? 7 : 5) * 86400 });
    if (applied) h.complete();
    try { assert.equal((await refresh(h)).state, 'candidate_expired'); assert.equal(h.counts().rollouts, 0); assert.equal(h.row().image, image); }
    finally { h.db.close(); }
  }
});

test('lease heartbeat runs during async Docker work and blocks another claim', async () => {
  const h = harness(); let clock = now, checked = false;
  const docker = async args => {
    if (args[0] === 'build') {
      clock += LEASE_SECONDS - 10;
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(h.row().lease_until > now + LEASE_SECONDS);
      await assert.rejects(claimLease(h.api, () => clock), /already_running/); checked = true;
      clock = now; // Keep fixture's signed report fresh.
    }
    return h.docker(args);
  };
  try { await refresh({ ...h, now: () => clock, heartbeatMs: 5, docker }); assert.equal(checked, true); assert.equal(h.counts().rollouts, 1); }
  finally { h.db.close(); }
});

test('lost lease owner cannot submit, finalize, renew or release a replacement owner', async () => {
  const h = harness(); h.seed(); let stolen = false;
  h.hooks.jobs = () => { h.db.prepare('UPDATE security_definition_updates SET run_id=?,lease_until=?').run('replacement', now + 5000); stolen = true; };
  try {
    await assert.rejects(refresh(h), /lease_expired/);
    assert.equal(stolen, true); assert.equal(h.counts().rollouts, 0);
    assert.equal(h.row().run_id, 'replacement'); assert.equal(h.row().lease_until, now + 5000);
  } finally { h.db.close(); }
});

test('crash marker before POST is conservative across runs and never bypasses submission budget', async () => {
  const h = harness(); h.seed({ pending_attempts: 5, pending_state: 'rollout_ambiguous' });
  try { assert.equal((await refresh(h)).state, 'reconciliation_stuck'); assert.equal(h.row().pending_attempts, 5); assert.equal(h.counts().rollouts, 0); }
  finally { h.db.close(); }
});

const okResponse = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
test('read-only API retries 500/timeout with jitter; mutation never automatically retries', async () => {
  let calls = 0; const waits = [];
  const fetcher = async () => { if (++calls === 1) return new Response('private HTML', { status: 500 }); if (calls === 2) throw Error('token=private'); return okResponse({ id: 'ok' }); };
  const api = cloudflareClient('private-token', { fetcher, sleep: async ms => waits.push(ms), random: () => 0.5 });
  assert.deepEqual(await api(APPLICATION_PATH), { id: 'ok' }); assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
  calls = 0;
  await assert.rejects(api(`${APPLICATION_PATH}/rollouts`, 'POST', {}), error => error.status === 500);
  assert.equal(calls, 1);
});

test('Retry-After seconds/date is honored, and an excessive value stops instead of retrying early', async () => {
  for (const retryAfter of ['7', new Date(now * 1000 + 7000).toUTCString(), '9999']) {
    let calls = 0; const waits = [];
    const api = cloudflareClient('test', { clock: () => now * 1000, random: () => 0.5, sleep: async ms => waits.push(ms),
      fetcher: async () => ++calls === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': retryAfter } }) : okResponse([]) });
    if (retryAfter === '9999') { await assert.rejects(api(APPLICATION_PATH)); assert.equal(calls, 1); assert.deepEqual(waits, []); }
    else { await api(APPLICATION_PATH); assert.deepEqual(waits, [7000]); assert.equal(calls, 2); }
  }
});

test('HTML/credential/transport errors retain safe metadata without logging token/password/body', async () => {
  const privateText = 'secret-token registry-password raw-credential';
  for (const response of ['html', 'json', 'transport']) {
    const api = cloudflareClient(privateText, { fetcher: async () => {
      if (response === 'transport') throw Error(privateText);
      return new Response(response === 'html' ? privateText : JSON.stringify({ success: false, errors: [{ code: 1000, message: privateText }] }),
        { status: 500, headers: { 'cf-ray': 'abcdef123456-NRT', 'retry-after': '8' } });
    } });
    await assert.rejects(api(`${APPLICATION_PATH}/rollouts`, 'POST', {}), error => {
      assert.equal(error.status, response === 'transport' ? 0 : 500);
      assert.equal(error.method, 'POST'); assert.equal(error.stage, 'rollout_list');
      const logged = JSON.stringify(safeError(error)) + String(error) + JSON.stringify(error);
      for (const secret of privateText.split(' ')) assert.equal(logged.includes(secret), false);
      if (response !== 'transport') { assert.equal(error.retryAfterMs, 8000); assert.equal(error.ray, 'abcdef123456-NRT'); }
      return true;
    });
  }
});

test('exhausted polling reads keep pending intent, then next run recovers', async () => {
  const h = harness(); h.seed({ pending_attempts: 1, pending_rollout_id: 'rollout' }); h.create();
  h.hooks.get = () => { throw new CloudflareError({ status: 500 }); };
  try {
    assert.equal((await refresh(h)).state, 'rollout_ambiguous'); assert.equal(h.row().pending_image, next);
    h.hooks.get = null; await refresh(h); assert.equal(h.row().image, next); assert.equal(h.counts().rollouts, 0);
  } finally { h.db.close(); }
});

test('reconcile-only with no intent does not build or perform a production mutation', async () => {
  const h = harness();
  try { await refresh({ ...h, reconcileOnly: true }); assert.deepEqual(h.counts(), { builds: 0, rollouts: 0 }); assert.equal(h.row().image, image); }
  finally { h.db.close(); }
});

test('polling through the real API client tolerates transient 500 and timeout without a second POST', async () => {
  const h = harness(); let faults = 0; const waits = [];
  const api = cloudflareClient('test-token', { sleep: async ms => waits.push(ms), random: () => 0.5,
    fetcher: async (url, options) => {
      const path = new URL(url).pathname.split(`/accounts/${ACCOUNT}`)[1];
      if (path.includes('/rollouts/') && faults++ < 2) {
        if (faults === 1) return new Response('provider failure', { status: 500 });
        throw new DOMException('request timed out', 'TimeoutError');
      }
      return okResponse(await h.api(path, options.method, options.body ? JSON.parse(options.body) : undefined));
    } });
  try { await refresh({ ...h, api }); assert.equal(h.row().image, next); assert.equal(h.counts().rollouts, 1); assert.deepEqual(waits, [1000, 2000]); }
  finally { h.db.close(); }
});

test('read-only D1 SELECT retries but D1 mutations cannot enter generic retry', async () => {
  for (const sql of ['SELECT 1', 'UPDATE private SET value=1']) {
    let calls = 0;
    const api = cloudflareClient('test', { sleep: async () => {}, fetcher: async () => {
      if (++calls === 1) return new Response('busy', { status: 500 }); return okResponse([]);
    } });
    const request = () => api(`/d1/database/${SECURITY_DB}/query`, 'POST', { sql }, { readOnly: true });
    if (sql.startsWith('SELECT')) { await request(); assert.equal(calls, 2); }
    else { await assert.rejects(request()); assert.equal(calls, 1); }
  }
});

test('malformed success response is an ambiguous POST, not a parse error losing HTTP status', async () => {
  let calls = 0;
  const api = cloudflareClient('test', { fetcher: async () => { calls++; return new Response('{', { status: 200 }); } });
  await assert.rejects(api(`${APPLICATION_PATH}/rollouts`, 'POST', {}), e => e.status === 200 && e.kind === 'parse');
  assert.equal(calls, 1);
});

test('actual reconciliation logger never prints raw provider error or credentials', async t => {
  const h = harness(); const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  h.hooks.post = () => { throw Error('token=very-private password=registry-secret raw-credential=payload'); };
  try {
    await refresh(h); assert.ok(logs.length > 0);
    const output = JSON.stringify(logs) + JSON.stringify(h.row());
    for (const word of ['very-private', 'registry-secret', 'payload']) assert.equal(output.includes(word), false);
  } finally { h.db.close(); }
});

test('expired lease during build prevents push and any production mutation', async () => {
  const h = harness(); let clock = now;
  try {
    await assert.rejects(refresh({ ...h, now: () => clock, docker: args => {
      const output = h.docker(args); if (args[0] === 'build') clock += LEASE_SECONDS + 1; return output;
    } }), /lease_expired/);
    assert.equal(h.counts().rollouts, 0); assert.equal(h.row().image, image);
  } finally { h.db.close(); }
});

test('external rollout conflict never replaces our durable rollout ID', async () => {
  const h = harness(); h.seed({ pending_attempts: 1, pending_rollout_id: 'ours' }); h.autoComplete = false; h.create();
  h.rollouts[0].target_configuration.image = image.replace(/a{64}$/, 'c'.repeat(64));
  try { await refresh(h); assert.equal(h.row().pending_state, 'rollout_conflict'); assert.equal(h.row().pending_rollout_id, 'ours'); }
  finally { h.db.close(); }
});

test('dispatch cannot exhaust the final observation slot without reconciliation', async () => {
  const h = harness(); h.hooks.post = () => { throw new CloudflareError({ status: 500 }); };
  try { assert.equal((await refresh({ ...h, maxPolls: 1 })).state, 'reconciliation_stuck'); assert.equal(h.counts().rollouts, 1); }
  finally { h.db.close(); }
});

test('pending states preserve expiry and hourly monitor alarms and deduplicate notification', async () => {
  const h = harness(); h.seed({ pending_state: 'rollout_pending', pending_started_at: now - 37 * 3600 });
  h.db.exec('UPDATE security_definition_updates SET hourly_monitor_checked_at=NULL');
  h.db.prepare('UPDATE security_definition_updates SET definition_unix=?').run(now - 7 * 86400 - 1);
  const issues = [], comments = [];
  const github = async (path, method = 'GET', body) => {
    if (method === 'GET') return issues;
    if (path.endsWith('/comments')) return comments.push(body);
    if (method === 'PATCH') return Object.assign(issues[0], body);
    issues.push({ ...body, number: 1, state: 'open' }); return issues[0];
  };
  try {
    const status = definitionStatus(h.row(), now);
    for (const state of ['rollout_pending', 'expired', 'monitor_stopped', 'reconciliation_stuck']) assert.ok(status.issues.includes(state));
    await monitor({ api: h.api, github, now }); await monitor({ api: h.api, github, now });
    assert.equal(issues.length, 1); assert.equal(comments.length, 0);
  } finally { h.db.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { definitionStatus, monitorDefinitions, runDefinitionSchedule } from '../../security-worker/src/definition-status.js';
import { refresh, candidateReport, definitionTarget } from '../tools/refresh-definitions.mjs';
import { notifyGithub, monitor } from '../tools/monitor-definitions.mjs';
import { ACCOUNT, SECURITY_DB, APPLICATION_PATH, waitForRollout } from '../tools/definition-api.mjs';

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
function database() { const db = new DatabaseSync(':memory:'); db.exec(migration); db.exec(hourlyMigration); return db; }
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
  let active = image, rollouts = 0, builds = 0;
  const api = async (path, method, body) => {
    if (path.includes(`/d1/database/${SECURITY_DB}/query`)) {
      const statement = db.prepare(body.sql);
      return [{ success: true, ...(body.sql.startsWith('SELECT') ? { results: statement.all(...body.params) } : { results: [], meta: statement.run(...body.params) }) }];
    }
    if (path.includes('/d1/database/')) return [{ success: true, results: [{ count: jobs }] }];
    if (path.endsWith('/credentials')) return { username: 'test', password: 'test' };
    if (path === APPLICATION_PATH) return { configuration: { image: active }, rollout_active_grace_period: 900 };
    if (path.endsWith('/rollouts')) {
      assert.deepEqual(body.steps.map(step => step.step_size.percentage), [10, 100]);
      assert.ok(body.steps.every(step => typeof step.description === 'string'));
      rollouts++; return { id: 'rollout' };
    }
    throw Error('unexpected_test_api');
  };
  const docker = args => {
    if (args[0] === 'build') { builds++; if (failure === 'build') throw Error('definition_docker_failed'); }
    if (args[0] === 'run') return JSON.stringify(failure === 'signature' ? { ...report, verified: false } : report);
    if (args[0] === 'image') return JSON.stringify([next]);
    return '';
  };
  const wait = async () => { if (failure === 'rollout') throw Error('definition_rollout_failed'); active = next; };
  return { db, api, docker, wait, now: () => now, counts: () => ({ rollouts, builds }), row: () => db.prepare('SELECT * FROM security_definition_updates').get() };
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

test('failed build/signature/rollout preserves last verified image and consecutive failures', async () => {
  for (const failure of ['build', 'signature', 'rollout']) {
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

test('rollout API acceptance is not completion; digest and active rollout must match', async () => {
  let polls = 0;
  const api = async path => path.endsWith('/rollouts/id') ? { status: ++polls === 1 ? 'running' : 'completed' } : { configuration: { image: next }, active_rollout_id: null };
  await waitForRollout(api, 'id', next, async () => {});
  assert.equal(polls, 2);
  await assert.rejects(waitForRollout(async () => ({ status: 'failed' }), 'id', next, async () => {}), /rollout_failed/);
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

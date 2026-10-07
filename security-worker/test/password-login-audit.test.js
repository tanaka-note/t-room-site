import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fixturePassword, securityDatabase } from './password-login-audit-fixture.mjs';
import { buildSecurityAuditEvent } from '../../assets/security-audit-worker.js';
import { readFileSync } from 'node:fs';

const telemetry = (stage = 'credential_derivation', reason = 'credential_derivation_failed') => ({
  eventType: stage === 'form_submit' ? 'password_login_submit' : 'password_login_client_failure',
  stage, reason, requestCorrelationId: crypto.randomUUID(), isPwa: false
});

for (const service of ['cloud', 'billing']) {
  test(`${service}: audit client script is publicly served through the real asset allowlist`,async()=>{
    const f=fixture(service);
    try {
      const source=readFileSync(new URL(`../../${service}-worker/public/password-login-audit.js`,import.meta.url),'utf8');
      const response=await f.asset('password-login-audit.js',source);
      assert.equal(response.status,200);assert.equal(await response.text(),source);
      assert.equal(f.stored.length,0);
    } finally {f.close();}
  });
  test(`${service}: real Security handler stores failures in SQLite and deduplicates Queue replay`, async () => {
    const f = fixture(service), s = await securityDatabase(f, service);
    try {
      if (service !== 'cloud') f.disablePassword();
      const r = await f.request('login', { loginId: f.loginId, password: service === 'cloud' ? 'incorrect-fixture' : fixturePassword });
      assert.equal(r.status, 401);
      const row = s.db.prepare("SELECT * FROM security_audit_events WHERE event_type='password_login_failure'").get();
      assert.equal(row.identity_id, 'audit-fixture');
      assert.equal(JSON.parse(row.details_json).reason, service === 'cloud' ? 'invalid_credentials' : 'password_auth_disabled');
      let ack = false;
      await s.worker.queue({ messages: [{body:f.stored[0],ack:()=>{ack=true;},retry:()=>assert.fail('Queue replay should persist')} ] });
      assert.equal(ack, true);
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM security_audit_events').get().n, 1);
      const body=telemetry();
      assert.equal((await f.request('password-login-audit',body)).status,204);
      assert.equal((await f.request('password-login-audit',body)).status,204);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM security_audit_events WHERE event_type='password_login_client_failure'").get().n,1);
      f.env.SECURITY.recordAuditEvent=async()=>{throw new Error('local RPC outage');};
      const retry=await f.request('login',{loginId:f.loginId,password:'incorrect-fixture'});
      assert.equal(retry.status,401);assert.equal(f.queued.length,1);
      await s.worker.queue({messages:[{body:f.queued[0],ack(){},retry:()=>assert.fail('Queue fallback must persist')}]});
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM security_audit_events WHERE event_type='password_login_failure'").get().n,2);
    } finally { s.close();f.close(); }
  });
  test(`${service}: password rejection is synchronously stored without waitUntil`, async () => {
    const f = fixture(service);
    try {
      const r = await f.request('login', { loginId: f.loginId, password: 'incorrect-local-fixture' });
      assert.equal(r.status, 401);
      assert.equal(r.cookie, null);
      assert.equal(f.stored.length, 1, 'authentication failure must reach Security before response');
      assert.equal(f.stored[0].eventType, 'password_login_failure');
      assert.equal(f.stored[0].details.reason, 'invalid_credentials');
      assert.equal(f.queued.length, 0);
    } finally { f.close(); }
  });
  test(`${service}: a pre-login client failure is stored separately`, async () => {
    const f = fixture(service);
    try {
      const r = await f.request('password-login-audit', { eventType: 'password_login_client_failure', stage: 'credential_derivation', reason: 'password_length_invalid', requestCorrelationId: crypto.randomUUID(), isPwa: false });
      assert.equal(r.status, 204);
      assert.equal(f.stored[0].eventType, 'password_login_client_failure');
      assert.equal(f.stored[0].details.stage, 'credential_derivation');
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n, 0);
    } finally { f.close(); }
  });
  test(`${service}: sync outage falls back to the identical event without changing counters`, async () => {
    const f = fixture(service);
    try {
      f.env.SECURITY.recordAuditEvent = async event => { f.attempted.push(event); throw new Error('local RPC outage'); };
      const id = crypto.randomUUID();
      const r = await f.request('login', { loginId: f.loginId, password: 'incorrect-local-fixture' }, { 'X-Login-Correlation-ID': id });
      assert.equal(r.status, 401); assert.equal(r.cookie, null);
      assert.deepEqual(f.queued, f.attempted);
      assert.equal(f.queued[0].details.requestCorrelationId, id);
      assert.equal(f.queued[0].details.counterUpdated, true);
      assert.equal(f.db.prepare(`SELECT failed_count FROM ${service}_login_attempts`).get().failed_count, 1);
      if (service === 'billing') assert.equal(f.db.prepare('SELECT failed_login_attempts FROM billing_accounts WHERE id=?').get(f.accountId).failed_login_attempts, 1);
    } finally { f.close(); }
  });
  test(`${service}: total audit outage remains fail-closed and logs only safe delivery metadata`, async () => {
    const f = fixture(service), messages = [], original = console.error;
    console.error = (...args) => messages.push(args);
    try {
      const secret = 'never-expose-password-proof-key-token';
      f.env.SECURITY.recordAuditEvent = async () => { throw new Error(secret); };
      f.env.SECURITY_AUDIT.send = async () => { throw new Error(secret); };
      const r = await f.request('login', { loginId: f.loginId, password: secret });
      assert.equal(r.status, 401); assert.equal(r.cookie, null);
      assert.ok(messages.some(args => args[1]?.reason === 'delivery_failed'));
      assert.doesNotMatch(JSON.stringify(messages), new RegExp(secret));
      assert.equal(f.db.prepare(`SELECT failed_count FROM ${service}_login_attempts`).get().failed_count, 1);
    } finally { console.error = original; f.close(); }
  });
  test(`${service}: malformed, missing and unknown IDs are audited without ID disclosure`, async () => {
    const f = fixture(service);
    try {
      for (const body of [{ loginId: '', password: 'local' }, { loginId: 'x'.repeat(255), password: 'local' }, '{malformed']) {
        const r = await f.request('login', body);
        assert.ok([400, 401].includes(r.status)); assert.equal(r.cookie, null);
        assert.equal(f.stored.at(-1).details.reason, 'invalid_request');
      }
      const unknown = await f.request('login', { loginId: 'unknown@example.test', password: fixturePassword });
      const wrong = await f.request('login', { loginId: f.loginId, password: 'incorrect-fixture' });
      assert.equal(unknown.status, 401); assert.deepEqual(unknown.body, wrong.body);
      assert.equal(f.stored.at(-2).details.reason, 'invalid_credentials');
      assert.doesNotMatch(JSON.stringify(f.stored), /unknown@example\.test|incorrect-fixture|x{255}/);
      if (service === 'billing') assert.ok(f.db.prepare('SELECT attempted_login_id FROM billing_audit_logs').all().every(r => r.attempted_login_id === null));
    } finally { f.close(); }
  });
  test(`${service}: lockout decisions and audit records match unchanged counters`, async () => {
    const f = fixture(service);
    try {
      for (let n = 0; n < 5; n++) assert.equal((await f.request('login', { loginId: f.loginId, password: 'incorrect-fixture' })).status, 401);
      if (service === 'billing') f.db.exec(`DELETE FROM billing_login_attempts; UPDATE billing_accounts SET locked_until=datetime('now','+15 minutes') WHERE id='masami'`);
      const before = JSON.stringify(f.db.prepare(`SELECT * FROM ${service}_login_attempts`).all());
      const r = await f.request('login', { loginId: f.loginId, password: fixturePassword });
      assert.equal(r.status, service === 'billing' ? 401 : 429); assert.equal(r.cookie, null);
      assert.equal(f.stored.at(-1).details.reason, 'login_locked');
      assert.equal(f.stored.at(-1).details.counterUpdated, false);
      assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${service}_login_attempts`).all()), before);
    } finally { f.close(); }
  });
  test(`${service}: telemetry validates origin, schema and size before any Security write`, async () => {
    const f = fixture(service);
    try {
      const valid = telemetry();
      for (const body of [{...valid, password: 'do-not-store'}, {...valid, authProof: 'do-not-store'}, {...valid, loginId: f.loginId}, {...valid, stage: '__proto__'}, {...valid, reason: 'secret'}, {...valid, requestCorrelationId: 'session-token'}, {...valid, buildId: 'raw-secret'}]) {
        assert.equal((await f.request('password-login-audit', body)).status, 400);
      }
      assert.equal((await f.request('password-login-audit', ' '.repeat(1025))).status, 413);
      assert.equal((await f.request('password-login-audit', valid, { Origin: 'https://foreign.test' })).status, 403);
      assert.equal(f.stored.length, 0);
      f.env.PASSWORD_AUDIT_RATE_LIMITER.limit = async () => ({ success: false });
      assert.equal((await f.request('password-login-audit', valid)).status, 429);
      assert.equal(f.stored.length, 0);
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n, 0);
    } finally { f.close(); }
  });
  test(`${service}: client telemetry retries retain an idempotent event ID`, async () => {
    const f = fixture(service);
    try {
      const body = telemetry();
      assert.equal((await f.request('password-login-audit', body)).status, 204);
      assert.equal((await f.request('password-login-audit', body)).status, 204);
      assert.equal(f.stored[0].eventId, f.stored[1].eventId);
      assert.equal(f.stored[0].details.reportedBy, 'client');
      assert.equal(f.stored[0].serviceAccountId, null);
      const before = f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n;
      f.env.SECURITY.recordAuditEvent = async () => { throw new Error('local RPC outage'); };
      f.env.SECURITY_AUDIT.send = async () => { throw new Error('local Queue outage'); };
      assert.equal((await f.request('password-login-audit', telemetry('form_submit', 'submitted'))).status, 503);
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n, before);
    } finally { f.close(); }
  });
}

for (const service of ['billing']) test(`${service}: disabled password with an active Passkey link rejects generically`, async () => {
  const f = fixture(service);
  try {
    f.disablePassword();
    const r = await f.request('login', { loginId: f.loginId, password: fixturePassword });
    assert.equal(r.status, 401); assert.equal(r.cookie, null);
    assert.equal(f.stored[0].details.reason, 'password_auth_disabled');
    assert.equal(f.stored[0].serviceAccountId, f.accountId);
    assert.equal(f.stored[0].details.counterUpdated, false);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n, 0);
    const unknown = await f.request('login', { loginId: 'unknown@example.test', password: fixturePassword });
    assert.deepEqual(unknown.body, r.body);
    assert.equal(unknown.status, r.status);
  } finally { f.close(); }
});

test('Diary: retired password requests preserve Security history, synchronous audit and Queue fallback without account writes', async () => {
  const f=fixture('diary'),s=await securityDatabase(f,'diary');
  try {
    const accounts=JSON.stringify(f.db.prepare('SELECT * FROM diary_accounts ORDER BY id').all());
    for(const body of [{loginId:f.loginId,password:fixturePassword},{loginId:'unknown@example.test',password:'wrong'},'{malformed']) {
      const r=await f.request('login',body);
      assert.equal(r.status,401);assert.equal(r.cookie,null);
      assert.equal(f.stored.at(-1).details.reason,'password_auth_disabled');
      assert.equal(f.stored.at(-1).details.counterUpdated,false);
    }
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE service='diary' AND auth_method='password' AND event_type='password_login_failure'").get().n,3);
    const event=f.stored[0];
    await s.worker.queue({messages:[{body:event,ack(){},retry:()=>assert.fail('Replay should persist')}]});
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM security_audit_events').get().n,3);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM diary_login_attempts').get().n,0);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM diary_accounts ORDER BY id').all()),accounts);
    assert.doesNotMatch(JSON.stringify(f.stored),/unknown@example\.test|local-audit-fixture-password/);
    // Old cached forms may still report metadata; it cannot create an authenticated session.
    assert.equal((await f.request('password-login-audit',telemetry())).status,204);
    f.env.SECURITY.recordAuditEvent=async()=>{throw Error('local RPC outage');};
    assert.equal((await f.request('login',{loginId:f.loginId,password:fixturePassword})).status,401);
    assert.equal(f.queued.length,1);
    await s.worker.queue({messages:[{body:f.queued[0],ack(){},retry:()=>assert.fail('Fallback should persist')}]});
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE event_type='password_login_failure'").get().n,4);
    const before=f.stored.length;
    assert.equal((await f.request('login',{password:fixturePassword},{Origin:'https://foreign.test'})).status,403);
    assert.equal(f.stored.length,before);
  } finally {s.close();f.close();}
});

test('Billing source rate limit has a separate audit reason and a generic response', async () => {
  const f = fixture('billing');
  try {
    await f.request('login', { loginId: f.loginId, password: 'incorrect-fixture' });
    f.db.exec(`UPDATE billing_login_attempts SET locked_until=${Math.floor(Date.now()/1000)+900}`);
    const r = await f.request('login', { loginId: f.loginId, password: fixturePassword });
    assert.equal(r.status, 401); assert.equal(r.cookie, null);
    assert.equal(f.stored.at(-1).details.reason, 'rate_limited');
    assert.equal(f.stored.at(-1).details.counterUpdated, false);
  } finally { f.close(); }
});

for(const service of ['billing']) test(`${service}: inactive accounts are classified internally with a generic rejection`,async()=>{
  const f=fixture(service);
  try {
    if(service==='diary') f.db.exec("INSERT INTO diary_accounts(id,household_id,display_name,login_id,role,active) VALUES ('inactive-fixture','tanaka-household','Fixture','inactive@example.test','user',0)");
    else f.db.prepare('UPDATE billing_accounts SET is_active=0 WHERE id=?').run(f.accountId);
    const r=await f.request('login',{loginId:service==='diary'?'inactive@example.test':f.loginId,password:fixturePassword});
    const unknown=await f.request('login',{loginId:'unknown@example.test',password:fixturePassword});
    assert.equal(r.status,401);assert.deepEqual(r.body,unknown.body);
    assert.equal(f.stored[0].details.reason,'account_disabled');
  } finally {f.close();}
});

test('Audit sanitization never serializes credentials, keys, raw sessions or request bodies', async () => {
  const body = Object.fromEntries(['password','passwordHash','authProof','credentialMaster','derivedKey','accountKey','aesKey','rsaKey','prfOutput','cookie','sessionToken','handoffToken','recoveryCode','loginId','formBody'].map(k => [k, `secret-${k}`]));
  const event = await buildSecurityAuditEvent(new Request('https://example.test/cloud/api/login', { method: 'POST', body: JSON.stringify(body), headers: { Cookie: 'raw-cookie', 'X-Login-Correlation-ID': 'raw-secret' } }), {
    service: 'cloud', eventType: 'password_login_failure', authMethod: 'password', outcome: 'failure', details: body
  });
  assert.doesNotMatch(JSON.stringify(event), /secret-|raw-cookie|raw-secret/);
});

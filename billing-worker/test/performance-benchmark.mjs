// Local synthetic SQLite/Service Binding fixture. This is not Cloudflare wall
// time, browser latency, or real WebAuthn. Never print inputs, rows, or cookies.
import assert from 'node:assert/strict';
import { fixture, seedLedger, baseline } from './performance-fixture.mjs';

const f = fixture();
const batchMode = process.argv.find(arg => arg.startsWith('--batch-mode='))?.slice('--batch-mode='.length) || 'batch';
if (batchMode !== 'batch') f.env.DB.batch = async statements => {
  if (batchMode === 'parallel') return Promise.all(statements.map(s => s.all()));
  assert.equal(batchMode,'sequential');
  const results=[];for(const s of statements)results.push(await s.all());return results;
};
try {
  seedLedger(f);
  const login = await f.login(); assert.equal(login.status, 200);
  const cookie = login.cookie;
  const cases = ['passkey/handoff', 'session', 'accounts', 'summary?accountId=chiharu&month=2026-10'];
  if (!baseline && process.argv.includes('--initial-data')) cases.push('accounts?includeSummary=1&month=2026-10');
  for (const path of cases) {
    const request = () => path === 'passkey/handoff' ? f.login() : f.request(path,cookie);
    for (let i = 0; i < 5; i++) assert.equal((await request()).status, 200);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      f.reset();
      const response = await request(); assert.equal(response.status, 200);
      samples.push({ ms: response.ms, billingMs: f.metrics.billing.sql.reduce((n, q) => n + q.ms, 0),
        rpcMs: f.metrics.rpc.reduce((n, r) => n + r.ms, 0),
        ...Object.fromEntries(Object.entries(f.metrics.timings).map(([key,values])=>[key,values.reduce((n,t)=>n+t,0)])) });
    }
    const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[15];
    console.log(JSON.stringify({ endpoint: path.includes('includeSummary') ? 'accounts+summary' : path.split('?')[0], batchMode, samples: samples.length,
      medianHandlerMs: median('ms'), medianBillingSqlMs: median('billingMs'), medianSecurityRpcMs: median('rpcMs'),
      medianSessionValidationMs:median('readSession'),medianSessionIssueMs:median('createSessionToken'),
      medianRefreshMs:median('refreshAuthenticatedSession'),medianAuditHelperWithMockMs:median('audit'),
      billingSql: f.metrics.billing.sql.length, billingBatches: f.metrics.billing.batches,
      securitySql: f.metrics.security.sql.length, authRpc: f.metrics.rpc.map(r => r.action) }));
    if (path.startsWith('summary')) {
      const plans = f.metrics.billing.sql.filter(q => /FROM billing_(entries|settlements)/.test(q.sql))
        .map(q => { const count = (q.sql.match(/\?/g) || []).length;
          return f.db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...Array.from({ length: count }, (_, i) => i === 0 ? 'chiharu' : '2026-10-01')).map(row => row.detail); });
      console.log(JSON.stringify({ queryPlans: plans }));
    }
  }
} finally { f.close(); }

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClientVault, unlockClient, wrapMaster } from '../public/health-crypto.mjs';
export function d1(database) {
  const query = (sql, args = []) => ({ bind: (...values) => query(sql, values), first: async () => database.prepare(sql).get(...args) || null, all: async () => ({ results: database.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(database.prepare(sql).run(...args).changes) } }) });
  return { prepare: query, batch: async statements => { database.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); database.exec('COMMIT'); return out; } catch (e) { database.exec('ROLLBACK'); throw e; } } };
}
export async function fixture({ master: importedMaster } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const master = importedMaster ? new Uint8Array(importedMaster) : randomBytes(32); const users = {};
  for (const person of ['owner', 'subject']) {
    const prf = new Uint8Array(randomBytes(32)); const vault = await createClientVault(prf);
    users[person] = { prf, bundle: { vault, wrappedKey: await wrapMaster(master, vault.publicKey) }, handoff: { identityId: person === 'owner' ? 'primary-admin' : 'fixture-subject', credentialId: `fixture-${person}`, serviceLinkId: `link-${person}`, serviceAccountId: 'nobumi', sessionEpoch: 1 } };
  }
  const auditEvents=[]; const tokens = new Map(); let revoked = false;
  const env = { DB: d1(db), SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_VERSION: '1', PASSKEY_ENABLED: 'true', SECURITY: {
    redeemHandoff: async (token, service) => { const user = tokens.get(token); tokens.delete(token); return service === 'health' && user ? user.handoff : null; },
    validatePasskeySession: async input => ({ valid: !revoked && Object.values(users).some(u => u.handoff.identityId === input.identityId && u.handoff.credentialId === input.credentialId && u.handoff.serviceLinkId === input.serviceLinkId && input.serviceAccountId === 'nobumi' && input.sessionEpoch === 1) }),
    getHealthKeyBundle: async input => !revoked ? Object.values(users).find(u => u.handoff.identityId === input.identityId && u.handoff.credentialId === input.credentialId && u.handoff.serviceLinkId === input.serviceLinkId)?.bundle || null : null,
    recordAuditEvent: async event => { auditEvents.push(event); return {stored:true}; }
  } };
  return { env, db, users, master, auditEvents, revoke: () => { revoked = true; }, issue: person => { const token = randomBytes(32).toString('hex'); tokens.set(token, users[person]); return token; } };
}
